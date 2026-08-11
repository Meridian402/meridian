// Self-hosted X account linking: OAuth 2.0 Authorization Code + PKCE against
// OUR OWN X developer app. No third party sits in the identity path.
//
// Deliberately NOT a login method. Sign-in stays wallet-only (SIWE), which is
// a decision the operator made once already; this links a VERIFIED X identity
// to an already-signed-in wallet so the earn surface can trust who authored a
// post. The access token is used for exactly one call (users/me) and then
// dropped: we store the X id and handle, never a credential, so a leak of our
// ledger leaks nothing that can act on anyone's account.
//
// DORMANT until X_OAUTH_CLIENT_ID and X_OAUTH_CLIENT_SECRET exist in the env.
// Arming lives in the X developer portal: OAuth 2.0 user authentication with
// callback ${PUBLIC_API}/api/auth/x/callback, scopes tweet.read users.read.
import { createHash, randomBytes } from "node:crypto";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";
import { existsSync, readFileSync } from "node:fs";

const LOG = "x-links.jsonl";
const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const ME = "https://api.x.com/2/users/me";
const STATE_TTL_MS = 10 * 60 * 1000;

export function xOAuthConfigured(): boolean {
  return Boolean(process.env.X_OAUTH_CLIENT_ID && process.env.X_OAUTH_CLIENT_SECRET);
}

interface PendingState {
  wallet: string;
  verifier: string;
  at: number;
}

// In-memory and single-use: a state survives ten minutes or one redemption,
// whichever ends first. One engine instance holds the signer and this map, so
// process-local is correct here, and a restart mid-handshake costs the user
// one extra click, not a security property.
const pending = new Map<string, PendingState>();

function prune(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** S256 code challenge from a verifier. Pure, for tests. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

/** The authorize URL for a wallet, plus the state now held server-side. */
export function beginLink(wallet: string, redirectUri: string): { url: string } {
  prune();
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { wallet: wallet.toLowerCase(), verifier, at: Date.now() });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_OAUTH_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    scope: "tweet.read users.read",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZE}?${q.toString()}` };
}

/** Redeem a state exactly once. Pure over the map, exported for tests. */
export function consumeState(state: string, nowMs = Date.now()): PendingState | null {
  const s = pending.get(state);
  if (!s) return null;
  pending.delete(state); // single-use even when expired: a replay gets nothing
  if (nowMs - s.at > STATE_TTL_MS) return null;
  return s;
}

/** Test seam: install a pending state without minting real randomness. */
export function _seedState(state: string, s: PendingState): void {
  pending.set(state, s);
}

export interface XLinkRow {
  ts: number;
  kind: "x-link";
  wallet: string;
  xId: string;
  handle: string;
}

function readLinks(): XLinkRow[] {
  const p = dataPath(LOG);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as XLinkRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is XLinkRow => !!r && r.kind === "x-link");
}

/** The verified X identity for a wallet, latest link wins. */
export function linkedAccount(wallet: string): { xId: string; handle: string } | null {
  const w = wallet.toLowerCase();
  const rows = readLinks();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].wallet === w) return { xId: rows[i].xId, handle: rows[i].handle };
  }
  return null;
}

/** THE ANTI-SYBIL RULE AT LINK TIME, same shape as the earn-side binding: an X
 *  account verifies to at most one wallet, ever. Re-linking the same pair is
 *  idempotent and fine; a second wallet claiming a linked account is refused.
 *  Pure over rows, for tests. */
export function linkRefusal(rows: readonly XLinkRow[], wallet: string, xId: string): string | null {
  const w = wallet.toLowerCase();
  for (const r of rows) {
    if (r.xId === xId && r.wallet !== w) return "that X account is already verified to a different wallet";
  }
  return null;
}

export interface LinkResult {
  ok: boolean;
  handle?: string;
  error?: string;
}

/** The callback half: code + state in, verified binding out. */
export async function completeLink(state: string, code: string, redirectUri: string): Promise<LinkResult> {
  const s = consumeState(state);
  if (!s) return { ok: false, error: "link session expired or already used, start again from the site" };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: s.verifier,
    client_id: process.env.X_OAUTH_CLIENT_ID ?? "",
  });
  const basic = Buffer.from(`${process.env.X_OAUTH_CLIENT_ID}:${process.env.X_OAUTH_CLIENT_SECRET}`).toString("base64");
  const tr = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!tr.ok) return { ok: false, error: `X rejected the code exchange (HTTP ${tr.status})` };
  const tok = (await tr.json()) as { access_token?: string };
  if (!tok.access_token) return { ok: false, error: "X returned no token" };

  const mr = await fetch(ME, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  // The token is not stored anywhere, on purpose: one identity read and done.
  if (!mr.ok) return { ok: false, error: `could not read the X profile (HTTP ${mr.status})` };
  const me = (await mr.json()) as { data?: { id?: string; username?: string } };
  if (!me.data?.id || !me.data.username) return { ok: false, error: "X returned no profile" };

  const refusal = linkRefusal(readLinks(), s.wallet, me.data.id);
  if (refusal) return { ok: false, error: refusal };

  appendLedger(LOG, { ts: Date.now(), kind: "x-link", wallet: s.wallet, xId: me.data.id, handle: me.data.username } satisfies XLinkRow);
  return { ok: true, handle: me.data.username };
}
