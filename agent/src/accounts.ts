// Wallet-as-account: the wallet IS the identity — no email, no password, on
// brand with "no accounts, no API keys." A user proves ownership by signing a
// short challenge (SIWE-style), and everything keyed to that address —
// reserved agent profiles today, deployed agents and tool spend tomorrow —
// becomes "their account." The signature only proves control of the wallet;
// it authorizes no transaction and moves no funds.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendLedger, ledgerView } from "./ledger.js";
import { verifyMessage, type Address } from "viem";
import { dataPath } from "./dataDir.js";

const ACCOUNTS_PATH = dataPath("accounts.jsonl");
const RESERVATIONS_PATH = dataPath("reservations.jsonl");
const NONCE_TTL_MS = 10 * 60 * 1000;

// Session tokens: once a wallet proves ownership (SIWE), it gets a stateless
// bearer good for a week so the chat routes don't re-prompt for a signature on
// every message. HMAC over `address:exp` — no server-side session store. Set
// MERIDIAN_SESSION_SECRET on the host to survive restarts; without it a random
// per-boot secret is used (everyone just re-signs after a redeploy).
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.MERIDIAN_SESSION_SECRET || randomBytes(32).toString("hex");

export interface WalletSession {
  token: string;
  address: string;
  expiresAt: number;
}

/** Mint a bearer that proves this (already-verified) wallet for a week. */
export function mintSession(address: string): WalletSession {
  const addr = address.toLowerCase();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(`${addr}:${expiresAt}`).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, address: addr, expiresAt };
}

/** Verify a session bearer; returns the wallet address it proves, or null. */
export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString();
  } catch {
    return null;
  }
  const idx = decoded.lastIndexOf(":");
  if (idx < 0) return null;
  const addr = decoded.slice(0, idx);
  const exp = Number(decoded.slice(idx + 1));
  if (!isAddress(addr) || !Number.isFinite(exp) || Date.now() > exp) return null;
  return addr;
}

// STATELESS SIWE challenge: the nonce is an HMAC over `address:issuedAt`, so it
// verifies on ANY replica with no shared store — survives restarts and lets us
// scale horizontally without breaking sign-ins (the old in-memory Map broke the
// moment a challenge and its link landed on different replicas). A best-effort
// in-process used-set blocks same-process replay; the short TTL bounds any
// cross-replica replay, and a session only unlocks the wallet's own advisor
// chat (no funds), so the residual surface is minimal.
const usedNonces = new Map<string, number>();

function signedNonce(address: string, issuedAt: number): string {
  const payload = Buffer.from(`${address.toLowerCase()}:${issuedAt}`).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(`nonce:${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyNonce(address: string, nonce: string): { ok: true } | { ok: false; error: string } {
  const dot = nonce.indexOf(".");
  if (dot <= 0) return { ok: false, error: "unknown challenge — reconnect and try again" };
  const payload = nonce.slice(0, dot);
  const sig = nonce.slice(dot + 1);
  const expected = createHmac("sha256", SESSION_SECRET).update(`nonce:${payload}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "invalid challenge — reconnect and try again" };
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString();
  } catch {
    return { ok: false, error: "malformed challenge" };
  }
  const idx = decoded.lastIndexOf(":");
  const addr = decoded.slice(0, idx);
  const iat = Number(decoded.slice(idx + 1));
  if (idx < 0 || addr !== address.toLowerCase()) return { ok: false, error: "challenge does not match this wallet" };
  if (!Number.isFinite(iat) || Date.now() - iat > NONCE_TTL_MS) return { ok: false, error: "challenge expired — reconnect and try again" };
  const now = Date.now();
  for (const [n, t] of usedNonces) if (now - t > NONCE_TTL_MS) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return { ok: false, error: "challenge already used — reconnect and try again" };
  usedNonces.set(nonce, now);
  return { ok: true };
}

const isAddress = (a: unknown): a is Address => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

function signInMessage(address: string, nonce: string): string {
  return (
    "Sign in to Meridian.\n\n" +
    "This links your account to this wallet. It does not authorize any transaction or move any funds.\n\n" +
    `Wallet: ${address}\n` +
    `Nonce: ${nonce}`
  );
}

/** Issue a one-time challenge for an address to sign. Returns the exact message the client must sign. */
export function issueChallenge(address: string): { message: string; nonce: string } | null {
  if (!isAddress(address)) return null;
  const nonce = signedNonce(address, Date.now());
  return { message: signInMessage(address, nonce), nonce };
}

interface AccountProfile {
  callsign: string;
  mandate: string;
  posture: string;
  at: number;
}

export interface AccountData {
  address: string;
  linkedAt: number;
  profiles: AccountProfile[];
}

// Both ledgers are folded once and indexed BY WALLET, then cached on the file's
// stat. The old shape scanned each whole file per call and kept only the rows
// matching one address, so the cost of answering for one wallet grew with every
// other wallet's history. This route runs on every page load with a wallet
// connected, which is the worst place to put a scan that scales with signups.
const reservationsByWallet = ledgerView<Map<string, AccountProfile[]>>("reservations.jsonl", (rows) => {
  // callsign is unique per wallet and the latest row wins, matching the
  // append-only semantics every other reader here uses.
  const latest = new Map<string, Map<string, AccountProfile>>();
  for (const r of rows as Array<Record<string, any>>) {
    const w = String(r.wallet ?? "").toLowerCase();
    if (!w || !r.callsign) continue;
    const forWallet = latest.get(w) ?? new Map<string, AccountProfile>();
    forWallet.set(r.callsign, { callsign: r.callsign, mandate: r.mandate, posture: r.posture, at: r.at });
    latest.set(w, forWallet);
  }
  const out = new Map<string, AccountProfile[]>();
  for (const [w, byCallsign] of latest) out.set(w, [...byCallsign.values()].sort((x, y) => y.at - x.at));
  return out;
});

const linkedAtByWallet = ledgerView<Map<string, number>>("accounts.jsonl", (rows) => {
  const out = new Map<string, number>();
  for (const r of rows as Array<Record<string, any>>) {
    const a = String(r.address ?? "").toLowerCase();
    if (a && typeof r.linkedAt === "number") out.set(a, r.linkedAt);
  }
  return out;
});

/** Drop both parsed views (tests, and anything that rewrites the files). */
export function resetAccountCache(): void {
  reservationsByWallet.reset();
  linkedAtByWallet.reset();
}

/** Public read of an account: everything linked to a wallet. The address is public on-chain, so this is open. */
export function accountData(address: string): AccountData | null {
  if (!isAddress(address)) return null;
  const a = address.toLowerCase();
  // Copies, because the cached arrays and objects are shared across requests.
  const profiles = (reservationsByWallet.get().get(a) ?? []).map((p) => ({ ...p }));
  return { address: a, linkedAt: linkedAtByWallet.get().get(a) ?? 0, profiles };
}

/** Verify a signed challenge and link the account. Returns the account data on success. */
export async function linkAccount(params: { address: string; nonce: string; signature: string }): Promise<{ ok: true; account: AccountData } | { ok: false; error: string }> {
  const { address, nonce, signature } = params;
  if (!isAddress(address)) return { ok: false, error: "invalid address" };
  const nonceCheck = verifyNonce(address, nonce);
  if (!nonceCheck.ok) return nonceCheck;
  let valid = false;
  try {
    valid = await verifyMessage({ address, message: signInMessage(address, nonce), signature: signature as `0x${string}` });
  } catch {
    return { ok: false, error: "malformed signature" };
  }
  if (!valid) return { ok: false, error: "signature does not match this wallet" };
  appendLedger("accounts.jsonl", { address: address.toLowerCase(), linkedAt: Date.now() });
  return { ok: true, account: accountData(address)! };
}
