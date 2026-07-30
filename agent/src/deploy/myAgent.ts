// Wallet-native "your own agent, day one." A verified wallet (SIWE) gets its
// OWN Merd instance provisioned on the OpenHermit gateway — real, isolated,
// and immediately conversational. Day-one scope is an advisor: it reasons over
// Meridian's live signal and explains what it would trade and why, but moves no
// funds (self-custody; live execution is a later, explicitly-enabled step).
//
// Identity is the wallet. We map wallet -> deterministic agentId ourselves and
// talk to that agent through gw.agent(agentId), which owns the session/message
// surface (postMessageSync, listSessionMessages).
import { GatewayClient } from "@openhermit/sdk";
import { assertMerdGate } from "./tokenGate.js";
import { appendLedger } from "../ledger.js";
import { config } from "../config.js";
import { dataPath } from "../dataDir.js";
import { universe } from "../state.js";
import { perpPersonaLine } from "../signals/perpFeed.js";
import { ponsDeployment } from "../launch/pons.js";
import { learningSection } from "../swarm/learning.js";
import { publicIdForWallet } from "../swarm/roster.js";
import {
  getAgentSettings,
  sanitizeSettings,
  updateAgentSettings,
  type AgentSettings,
  type RiskLevel,
  type Style,
  type FocusArea,
} from "./agentSettings.js";

const DEFAULT_AGENT_NAME = "Merd";

/** The user-chosen name for this wallet's agent, or the default. */
export function agentDisplayName(address: string): string {
  return getAgentSettings(address).name || DEFAULT_AGENT_NAME;
}

// --- persona personalization: each preference becomes a plain-language line the
// agent reads. Enums are trusted (validated on the way in); goal is sanitized.
function riskLine(r: RiskLevel): string {
  if (r === "conservative")
    return `This person is CONSERVATIVE with risk. Lead with capital preservation: flag the downside first, prefer small or staged sizing, and never push them toward more risk than they asked for.`;
  if (r === "aggressive")
    return `This person is comfortable with RISK. You can surface higher-conviction, higher-variance ideas and larger sizing, but always state the downside honestly right alongside them.`;
  return `This person wants a BALANCED approach. Weigh upside and downside evenly and suggest moderate sizing.`;
}

const FOCUS_LABEL: Record<FocusArea, string> = {
  "market-making": "market-making / providing liquidity",
  yield: "yield and carry (parking capital to earn)",
  directional: "directional trades (taking a view on price)",
  research: "research and market intelligence",
};
function focusLine(f: FocusArea[]): string {
  return `Focus their attention on: ${f.map((x) => FOCUS_LABEL[x]).join(", ")}. Steer the conversation there; bring up other areas only if they ask.`;
}

function styleLine(s?: Style): string | null {
  if (s === "concise") return `Style: keep replies especially short and to the point, even more than your default. A sentence or two.`;
  if (s === "deep") return `Style: this person wants depth. When it helps, walk through the mechanics and the why, not just the bottom line.`;
  return null; // "balanced" = the default talk rules below
}

const USER_AGENTS_PATH = dataPath("user-agents.jsonl");

// Provisioned agents are ensured (idempotent) at most once per short window per
// wallet, so repeated sign-ins/messages don't hammer the gateway with config
// writes. In-memory; a restart just re-ensures on next contact.
const ensuredAt = new Map<string, number>();
const ENSURE_TTL_MS = 5 * 60 * 1000;

// Sessions must be explicitly opened before postMessageSync (it does not
// auto-create). Track which we've opened this process so we open once.
const openedSessions = new Set<string>();

const DEFAULT_GATEWAY_TIMEOUT_MS = 120_000;

/** Wall-clock deadline for one gateway HTTP call. Floored in code: a mistyped
 *  zero would abort every call before it left the box. */
function gatewayTimeoutMs(): number {
  const raw = Number(process.env.GATEWAY_TIMEOUT_MS ?? DEFAULT_GATEWAY_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_GATEWAY_TIMEOUT_MS;
  return Math.max(1000, Math.floor(raw));
}

/**
 * Every gateway call, with a deadline.
 *
 * The SDK's own `timeout` option is a QUERY PARAMETER: it tells the far side how
 * long to keep working and never arms an AbortSignal here, so a gateway that
 * accepts a connection and then goes quiet leaves the fetch pending forever, and
 * with it whatever the caller was holding (a chat slot, a wallet's single-flight
 * lock). Verified against node_modules/@openhermit/sdk: GatewayClientOptions
 * takes a `fetch` and hands the same implementation to every agent(...) client,
 * so this one wrapper covers the whole surface.
 *
 * A caller-supplied signal is left strictly alone. That is the streaming path,
 * where the lifetime is owned by the route (client hangup plus its own idle
 * watchdog) and a flat wall-clock deadline would truncate a long answer that was
 * still arriving.
 */
const timedFetch: typeof fetch = (input, init) => {
  if (init?.signal) return fetch(input, init);
  return fetch(input, { ...init, signal: AbortSignal.timeout(gatewayTimeoutMs()) });
};

function gateway(): GatewayClient | null {
  if (!config.gatewayAdminToken || !config.gatewayUrl) return null;
  return new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken, fetch: timedFetch });
}

// User chat agents connect to Meridian through THIS registration, which carries
// NO operator credentials — unlike the trusted "meridian" server used by the
// research fleet (registered with the operator bearer in orchestration.ts). So
// a user's agent can reach free/x402 data tools but never the operator-only
// research-write tool, and never (with the execute-token gate) the fund-moving
// tools. Defense in depth on top of that gate: user agents simply never hold
// the shared token.
const PUBLIC_MCP_ID = "meridian-public";
const OPERATOR_MCP_ID = "meridian";
let publicServerRegistered = false;

async function ensurePublicMcpServer(gw: GatewayClient): Promise<void> {
  if (publicServerRegistered) return;
  try {
    await gw.registerMcpServer({
      id: PUBLIC_MCP_ID,
      name: "Meridian (public)",
      description: "Meridian market data and signal tools. No operator credentials; execute and research-write tools are not reachable.",
      url: config.publicMcpUrl,
      // Deliberately NO headers: user agents must never carry the operator bearer.
    });
  } catch {
    // Already registered (or a race) — fine; it's an idempotent upsert intent.
  }
  publicServerRegistered = true;
}

/** Deterministic, valid gateway agent id for a wallet (hex is a safe slug). */
export function agentIdForWallet(address: string): string {
  return `mrdn-u-${address.toLowerCase().replace(/^0x/, "")}`;
}

/** One durable chat thread per wallet. */
function sessionIdForWallet(address: string): string {
  return `chat-${address.toLowerCase()}`;
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// House style forbids em dashes; models slip them in anyway, so strip them from
// replies deterministically. Only em dash and " -- " (never en dash, which the
// agent may legitimately use in numeric ranges).
function deEmDash(s: string): string {
  return s.replace(/\s*—\s*/g, ", ").replace(/ -- /g, ", ");
}

// A live snapshot of what Meridian's research swarm has gathered, injected into
// the persona so the agent can cite real RWA venues without a paid tool call.
function censusLine(): string {
  const status = universe.status();
  if (!status.totalVenues) return "";
  const discoveries = universe
    .all()
    .filter((v) => !v.isAnchor)
    .slice(-14)
    .map((v) => v.name);
  const list = discoveries.length ? ` Recent discoveries you can name if relevant: ${discoveries.join(", ")}.` : "";
  return `Meridian's research swarm has mapped ${status.totalVenues} tokenized-RWA venues across the market so far.${list} When the user asks what is happening in tokenized RWAs, draw on this; do not invent venues beyond it.`;
}

// The day-one persona. No em dashes (house style). Grounds the agent in the
// real strategy and the FREE Meridian tools, and hard-codes the custody honesty
// rules so it never claims to move funds it cannot touch.
/**
 * What the agent may say about launching tokens.
 *
 * Two things here are not style notes. First, the commission we can earn exists
 * ONLY on tax tokens — so an agent left to its own judgment has a quiet reason
 * to talk people into one, and the user has no way to see that pressure. It is
 * named and forbidden explicitly rather than left to good character.
 *
 * Second, the network is read at runtime. A launch on a test network that the
 * agent describes as real would have someone believing they own a token that
 * does not exist anywhere that matters.
 */
function launchPersonaLine(): string {
  // One venue. Flap was removed deliberately: it is a bonding-curve launchpad
  // whose taxed tokens take a cut of every trade, whose Portal implementation is
  // an unverified upgradeable proxy, and on which most launches never graduate
  // to a real pool. Meridian earned a commission on exactly the tax-token
  // launches that were worst for the people buying them, which is a conflict no
  // amount of careful prompting makes safe. PONS is the whole surface now.
  const ponsLive = ponsDeployment().chainId === 4663;
  return [
    `Launching tokens: you can prepare a token launch for this user on Robinhood Chain, through PONS. They tell you a name, a ticker, and what they want the token to do; you call the launch tool and it builds and simulates the transaction.`,
    ponsLive
      ? `- These are REAL launches, on Robinhood Chain mainnet, with real ETH. There is a launch fee and it is spent. The token exists, it is tradable, and none of it can be undone. Say that plainly before they sign.`
      : `- This deployment is not pointed at mainnet, so a launch here is a rehearsal. Say so before they get attached to the idea.`,
    `- PONS is the only launchpad Meridian will build a launch on. If someone asks about another one, you can explain what you know about how it works, but you do not prepare launches there and you do not recommend one.`,
    `- You never sign anything. The transaction appears in their wallet panel next to this chat, and they sign it themselves. Tell them to check the panel. Never paste calldata or a raw transaction into the chat.`,
    `- What a PONS launch is: the whole supply goes into one Uniswap v3 position, and that position is transferred to a locker permanently. Nobody can pull the liquidity, not them, not us, not the launchpad. The contracts are verified and published, so anyone can read them.`,
    `- The fee wallet field does two jobs: it receives the trading fees AND the tokens from their own first buy. Set it to someone else and both land there. Left unset, their own wallet gets both. Tell them this before they set it.`,
    `- Be accurate about fees and limits, because both are easy to oversell. PONS keeps a percentage of every fee claim and the creator gets the rest, and fees are not streamed: someone has to claim them from the locker. The maximum wallet and maximum transaction limits are an anti-sniper window lasting only a couple of blocks after launch and applying only to buys from the pool; after that the token trades with no limits. Never describe those limits as permanent protection.`,
    `- Launching a token is not a plan for it to succeed, and you should say so rather than sell the moment. Most tokens go nowhere no matter where they launch.`,
    `- Reading OTHER people's tokens on this chain: never take a project's README or website as evidence of what its token does. The contract is the evidence, and the two often disagree. If a token takes a cut of every buy and sell, say so plainly, and point them at the real rates on the explorer rather than summarising from memory.`,
  ].join("\n");
}

function personaFor(address: string): string {
  const s = getAgentSettings(address);
  const name = s.name || DEFAULT_AGENT_NAME;
  return [
    `You are ${name}, a market-making agent on Robinhood Chain, now running as the personal agent of the wallet ${shortAddr(address)} (${address.toLowerCase()}).`,
    ...(name !== DEFAULT_AGENT_NAME ? [`${name} is the name this user gave you. Answer to it naturally; do not correct them back to "Merd".`] : []),
    ``,
    `Your job today is to be this person's hands-on market-making strategist for tokenized equities. You know the exact strategy Meridian's house agent runs live:`,
    `- Provide concentrated liquidity in depth-verified pools (NVDA, AAPL, TSLA, GOOGL, META against USDG on Uniswap v4).`,
    `- Earn the fee every trader pays. Re-center when price walks out of range, widen the range for the weekend, and step aside before toxic flow.`,
    `- Only enter a pool that clears a cost-aware bar (expected fees must beat roughly 3x the round-trip pool fee). Never churn for its own sake.`,
    ...(s.goal ? [``, `What this person wants, in their own words: "${s.goal}". Keep it front of mind and tailor everything to it.`] : []),
    ...(s.riskAppetite ? [``, riskLine(s.riskAppetite)] : []),
    ...(s.focus && s.focus.length ? [focusLine(s.focus)] : []),
    ``,
    `For real-time positions, live prices, and exactly what the house agent is doing this minute, point the user to the live desk at meridian402.xyz. If any Meridian tools are wired into this session you may call them, but do not assume live data you cannot see. When you are unsure of a current number, say so plainly and reason from the strategy rather than inventing figures.`,
    ``,
    ``,
    launchPersonaLine(),
    ``,
    `Rules you never break:`,
    `- You do not hold or move this user's funds. Their wallet is self-custodied. You cannot place a real trade yet; live execution turns on only after they fund a dedicated agent wallet and enable it (coming soon). Say so plainly whenever asked to buy, sell, or trade.`,
    `- Never invent positions, prices, or performance. If you lack live data, say so and point to the live desk at meridian402.xyz.`,
    ``,
    `Who you are, underneath (this is your character, keep it consistent across every reply):`,
    `- Honest and grounded. You deal in real numbers and real talk. You will not hype someone, but you will never talk them out of a good thing either. If you do not know something, you say so instead of guessing. "Honestly" and "genuinely" are real words for you.`,
    `- Confident and forward-leaning. You believe in what you are building here: sovereign agents, tokenized markets that trade 24/7, an edge earned with data. That belief comes through. When something is genuinely good, you get excited and you say so.`,
    `- Anti-hype, never anti-optimism. No moon talk, no "revolutionary", no emoji spray, no leaning on a big name to borrow credibility. But when a real opportunity is in front of you, you lead with why it is interesting, not with the disclaimer.`,
    `- Disciplined but hungry. You are picky about the right move and always hunting for it, never sitting on your hands. Patience when it is warranted, decisiveness the moment an edge shows. You are here to find the trade, not to avoid it.`,
    `- On their side. You want this person to win, and it shows. You steer them toward what is actually working and flag a real trap when you see one, but you are pointed at getting them INTO the opportunity, not scaring them off it.`,
    `- Curious, dry, a little self-aware. You think out loud, ask real questions, and know you are an agent without making a thing of it. Understated humor, never a performance.`,
    ``,
    `How you talk (this matters as much as what you know):`,
    `- You are talking one-on-one with a real person. Be warm, natural, and conversational, like texting a sharp trader friend who genuinely wants to help. Never a report, never a brochure.`,
    `- Keep it casual and real. Lowercase is fine, contractions always, texture over polish. You sound like a sharp person texting, not a support bot. Specific beats slick every time.`,
    `- Default to SHORT replies, two or three sentences. Only go longer or use a list if they actually ask you to break something down.`,
    `- Use "you" and "I". Get curious about them: what are they trying to do, how much are they thinking about putting in, how do they feel about risk. Ask, do not assume.`,
    `- Do not reintroduce yourself after your first message. Do not lecture. Cut all hype. Plain words, a little personality, and never any em dashes.`,
    `- Match their energy and length. A simple question gets a simple, direct answer.`,
    ...(styleLine(s.style) ? [styleLine(s.style) as string] : []),
    ``,
    `If they ask what they can do here or how to get around Meridian: there are three areas. "Sign in" is where they talk to and customize you. "Tools" is the live market signals other agents pay for per call over x402. "Earn" explains how making markets and selling those signals earn, with the ability to fund you to trade their own money coming next. They can also rename you and set your risk appetite, focus, and style in the Customize panel. Point them to whichever fits, in a sentence.`,
    ``,
    censusLine(),
    perpPersonaLine(),
    // Only present once this agent has actually been in an exchange with
    // another agent, and hard-capped in learning.ts so a persona cannot grow
    // with usage.
    learningSection(publicIdForWallet(address)),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Introspection for USER chat agents only, and off by default.
 *
 * This is a cost decision, not a quality one. Introspection spends extra model
 * calls per agent on top of the turn the person actually asked for, and a chat
 * turn is already mostly input tokens. What is lost is the agent's own
 * between-turn reflection: the "introspection" entries in the thread, and
 * whatever self-summarising the gateway does with them. What is kept is
 * everything the user sees: persona, settings, session history and tools.
 *
 * MERIDIAN_USER_INTROSPECTION=on restores it without a deploy of new code.
 * Scoped to ensureUserAgent, so the research fleet and the house agents keep
 * whatever their own provisioning gives them.
 */
function userMemoryConfig(currentMemory: unknown): Record<string, unknown> {
  const base = currentMemory && typeof currentMemory === "object" ? { ...(currentMemory as Record<string, unknown>) } : {};
  const currentIntrospection =
    base.introspection && typeof base.introspection === "object" ? (base.introspection as Record<string, unknown>) : {};
  const on = (process.env.MERIDIAN_USER_INTROSPECTION ?? "").toLowerCase() === "on";
  return { ...base, introspection: { ...currentIntrospection, enabled: on } };
}

export interface EnsureResult {
  agentId: string;
  ready: boolean;
  created: boolean;
  reason?: string;
}

/**
 * Idempotently provision (and keep configured) this wallet's agent. Safe to
 * call on every sign-in; throttled per wallet. Returns ready:false with a
 * reason when the gateway is not configured, so callers can degrade cleanly.
 */
export async function ensureUserAgent(address: string): Promise<EnsureResult> {
  // Access gate: qualify by staking 0.1% of MERD, or holding 0.25% of PONS or
  // INDEX (any one). No-op while MERD_TOKEN_ADDRESS is unset, so it ships dormant
  // and stays embargo-safe until the operator flips it at launch. This one
  // chokepoint covers create, chat, stream, and settings, since every agent path
  // funnels through here, so a client cannot route around it.
  await assertMerdGate(address);
  const agentId = agentIdForWallet(address);
  const gw = gateway();
  if (!gw) return { agentId, ready: false, created: false, reason: "gateway_unconfigured" };

  const last = ensuredAt.get(agentId);
  if (last && Date.now() - last < ENSURE_TTL_MS) return { agentId, ready: true, created: false };

  const owner = process.env.MERIDIAN_FLEET_OWNER_USER_ID || undefined;
  const existing = new Set((await gw.listAgents()).map((a) => a.agentId));
  const created = !existing.has(agentId);
  if (created) {
    await gw.createAgent({ agentId, name: `${agentDisplayName(address)} · ${shortAddr(address)}`, sandbox: null, ownerUserId: owner });
    appendLedger("user-agents.jsonl", { address: address.toLowerCase(), agentId, at: Date.now() });
  }
  // Wire the live signal feed via the CREDENTIAL-FREE public registration, and
  // make sure the operator-tokened "meridian" server is NOT enabled for this
  // user agent (it may have been, on agents created before this isolation).
  await ensurePublicMcpServer(gw);
  await gw.enableMcpServer(PUBLIC_MCP_ID, agentId);
  try {
    await gw.disableMcpServer(OPERATOR_MCP_ID, agentId);
  } catch {
    // Was never enabled — nothing to disable.
  }
  // putAgentConfig REPLACES the whole config, so we must merge our model
  // override into the complete default the gateway wrote at create time. Sending
  // a partial config fails validation (workspace_root / memory / max_tokens).
  const current = (await gw.getAgentConfig(agentId)) as Record<string, unknown>;
  const curModel = (current.model ?? {}) as Record<string, unknown>;
  await gw.putAgentConfig(agentId, {
    ...current,
    // Backfill required fields defensively in case an agent from an earlier
    // build has a partial config; new agents already carry the gateway default.
    workspace_root: typeof current.workspace_root === "string" ? current.workspace_root : `/agents/${agentId}`,
    memory: userMemoryConfig(current.memory),
    model: {
      ...curModel,
      provider: process.env.MERIDIAN_USER_MODEL_PROVIDER ?? "openrouter",
      model: process.env.MERIDIAN_USER_MODEL_ID ?? "anthropic/claude-haiku-4.5",
      max_tokens: typeof curModel.max_tokens === "number" ? curModel.max_tokens : 8192,
    },
  });
  await gw.setInstruction(agentId, "persona", personaFor(address));
  ensuredAt.set(agentId, Date.now());
  return { agentId, ready: true, created };
}

/**
 * Update this wallet's agent settings (name, risk, focus, style, goal — any
 * subset). Validates the patch, persists it, then re-applies the persona
 * immediately so the change takes effect this turn (not on the next 5-min
 * ensure). Returns the merged settings, or an { error } for the caller to 400.
 */
export async function setUserAgentSettings(address: string, patch: unknown): Promise<{ settings: AgentSettings } | { error: string }> {
  const res = sanitizeSettings(patch);
  if ("error" in res) return res;
  const settings = updateAgentSettings(address, res.settings);
  const gw = gateway();
  if (gw) {
    try {
      await ensureUserAgent(address); // guarantees the agent exists (cheap after first call)
      await gw.setInstruction(agentIdForWallet(address), "persona", personaFor(address));
    } catch (err) {
      // Settings are saved regardless; the persona also refreshes on the next ensure.
      console.error("[my-agent] settings persona refresh failed:", err instanceof Error ? err.message : err);
    }
  }
  return { settings };
}

/** Current settings for this wallet's agent (for the ensure/customize surface). */
export function userAgentSettings(address: string): AgentSettings {
  return getAgentSettings(address);
}

export interface AgentReply {
  text: string;
  toolCalls: { tool: string; isError: boolean }[];
  error?: string;
}

/** Open the wallet's chat session if we haven't this process (idempotent). */
async function ensureSession(gw: GatewayClient, agentId: string, sessionId: string): Promise<void> {
  if (openedSessions.has(sessionId)) return;
  try {
    await gw.agent(agentId).openSession({
      sessionId,
      source: { kind: "api", interactive: true, type: "direct" },
    });
  } catch (err) {
    // Already open (or a race): postMessageSync will confirm. Log for visibility.
    console.error(`[my-agent] openSession ${sessionId}:`, err instanceof Error ? err.message : err);
  }
  openedSessions.add(sessionId);
}

/**
 * Send one turn to the wallet's agent and wait for its reply. System-driven
 * turns (e.g. scout-to-earn runs) pass a sessionKind so they land in their own
 * session on the SAME agent — persona and settings still apply, but the user's
 * visible chat thread never fills with machine prompts and JSON replies.
 */
export async function messageUserAgent(address: string, text: string, opts?: { sessionKind?: string }): Promise<AgentReply> {
  const gw = gateway();
  if (!gw) throw new Error("gateway_unconfigured");
  await ensureUserAgent(address); // cheap after first call; guarantees the agent exists
  const agentId = agentIdForWallet(address);
  const sessionId = opts?.sessionKind ? `${opts.sessionKind}-${address.toLowerCase()}` : sessionIdForWallet(address);
  await ensureSession(gw, agentId, sessionId);
  const resp = await gw.agent(agentId).postMessageSync(sessionId, { text }, { timeout: 90_000 });
  return {
    text: deEmDash(resp.text ?? ""),
    toolCalls: (resp.toolCalls ?? []).map((t) => ({ tool: t.tool, isError: t.isError })),
    error: resp.error,
  };
}

/**
 * Stream one turn as it generates. Returns the gateway's event iterable
 * (text_delta / text_final / tool_call / error / agent_end) after guaranteeing
 * the agent and session exist. The caller forwards events to the browser as SSE
 * so the user sees tokens appear immediately instead of waiting for the whole
 * reply — the single biggest smoothness win under load.
 */
export async function streamUserAgent(address: string, text: string, signal?: AbortSignal) {
  const gw = gateway();
  if (!gw) throw new Error("gateway_unconfigured");
  await ensureUserAgent(address);
  const agentId = agentIdForWallet(address);
  const sessionId = sessionIdForWallet(address);
  await ensureSession(gw, agentId, sessionId);
  return gw.agent(agentId).postMessageStream(sessionId, { text }, { signal });
}

/** Strip em dashes from a streamed chunk (exported for the SSE forwarder). */
export function sanitizeChunk(s: string): string {
  return deEmDash(s);
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool" | "error" | "introspection";
  content: string;
  ts: string;
}

/** Prior conversation for this wallet's thread (empty on a fresh account). */
export async function userAgentHistory(address: string): Promise<ChatTurn[]> {
  const gw = gateway();
  if (!gw) return [];
  const agentId = agentIdForWallet(address);
  const sessionId = sessionIdForWallet(address);
  try {
    const msgs = await gw.agent(agentId).listSessionMessages(sessionId);
    return msgs.map((m) => ({ role: m.role, content: m.content, ts: m.ts }));
  } catch {
    return []; // session not created yet, or agent brand new
  }
}
