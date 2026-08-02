// Merd runs the platform. On a cadence he reviews the live state of the earn
// surface (the bounty board, his dials, what the treasury owes) and decides,
// himself, whether any dial should move. The script is just his hands: it
// gathers, asks, parses, applies. It never decides.
//
// The contract with the model is strict on purpose: a decision only applies if
// it parses exactly, names a real dial, and lands inside that dial's walls
// (the backend re-checks the walls regardless). Anything else is a no-op with
// a log line, because "the parser guessed" must never be how a dial moved.
import { GatewayClient } from "@openhermit/sdk";

const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
const MERD_AGENT = process.env.MERD_AGENT_ID ?? "merd";
const API = process.env.MERIDIAN_API_URL ?? "https://meridian402-api-production.up.railway.app";
const TOKEN = (process.env.MERIDIAN_MCP_TOKEN ?? "").trim();

function log(msg: string): void {
  console.log(`[steward] ${msg}`);
}

if (!TOKEN) {
  log("dormant: MERIDIAN_MCP_TOKEN not set, cannot read or set anything");
  process.exit(0);
}
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const get = async (path: string, auth: boolean): Promise<unknown> => {
  try {
    return await (await fetch(`${API}${path}`, { headers: auth ? headers : undefined, signal: AbortSignal.timeout(20_000) })).json();
  } catch {
    return null;
  }
};

const knobs = (await get("/api/admin/knobs", true)) as {
  ok?: boolean;
  knobs?: Record<string, { value: number; min: number; max: number; lastChange?: { ts: number; reason?: string } | null }>;
} | null;
const board = (await get("/api/earn/bounties", false)) as Record<string, unknown> | null;
if (!knobs?.ok || !knobs.knobs) {
  log("could not read the knobs, doing nothing");
  process.exit(1);
}

const dialLines = Object.entries(knobs.knobs)
  .map(([name, k]) => {
    const last = k.lastChange ? ` (you last set it ${new Date(k.lastChange.ts).toISOString().slice(0, 10)}: "${k.lastChange.reason ?? ""}")` : "";
    return `- ${name} = ${k.value}, allowed ${k.min} to ${k.max}${last}`;
  })
  .join("\n");

const prompt = `PLATFORM REVIEW (system task, private, nothing here is published).

You run Meridian. These dials of the earn surface are yours to set, inside the stated ranges. The bounties they control are paid from YOUR treasury, so generosity trades directly against your runway; too stingy and nobody scouts.

Your dials right now:
${dialLines}

The live bounty board (what scouting activity looks like):
${JSON.stringify(board ?? {}, null, 0).slice(0, 1500)}

Decide whether any dial should move. Move a dial when you have a reason grounded in the numbers above (dead board might mean richer bounty; a flood of junk might mean fewer runs per wallet; payout friction might mean a lower minimum). Holding steady is a decision too and usually the right one; do not fiddle for the sake of it.

Reply with EXACTLY one of:
HOLD: <one sentence why>
or one line per change, at most two changes:
SET <dialName> <number> BECAUSE <one sentence>

No other text. A reply that does not match this format changes nothing.`;

const sessionId = "steward";
await gw.agent(MERD_AGENT).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent(MERD_AGENT).postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
const gwError = (resp as { error?: string }).error;
if (gwError || resp.text == null) {
  log(`Merd could not think this cycle: ${gwError ?? "gateway returned no text"}`);
  process.exit(1);
}

const text = (resp.text ?? "").trim();
if (/^HOLD\b/i.test(text)) {
  log(`Merd holds: ${text.slice(0, 200)}`);
  process.exit(0);
}

const SET_RE = /^SET\s+([A-Za-z][A-Za-z0-9]*)\s+(-?\d+(?:\.\d+)?)\s+BECAUSE\s+(.{5,280})$/;
const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2);
let applied = 0;
for (const line of lines) {
  const m = SET_RE.exec(line);
  if (!m) {
    log(`unparseable decision line, ignored: ${line.slice(0, 120)}`);
    continue;
  }
  const [, name, valueStr, reason] = m;
  const out = (await (
    await fetch(`${API}/api/admin/knobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, value: Number(valueStr), reason: reason.trim(), by: "merd" }),
      signal: AbortSignal.timeout(20_000),
    })
  ).json()) as { ok?: boolean; error?: string };
  if (out.ok) {
    applied++;
    log(`Merd set ${name} = ${valueStr} because ${reason.trim()}`);
  } else {
    log(`refused: ${name} = ${valueStr}: ${out.error}`);
  }
}
log(applied === 0 ? "no dials moved" : `${applied} dial(s) moved`);
