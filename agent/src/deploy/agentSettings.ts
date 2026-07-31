// Per-wallet customization for a user's personal agent — the "build your own
// agent" surface. An extensible settings OBJECT stored append-only, latest-row-
// wins per wallet, mirrored to Postgres like every other ledger. Reads are
// local + sync. Everything here is prompt-level: the agent is an advisor, so a
// preference only exists if it genuinely changes how the agent reasons or talks.
// Enums are validated against fixed sets; the one free-text field (goal) is
// sanitized, so nothing a user types can smuggle instructions into the persona.
import { appendLedger, ledgerView } from "../ledger.js";

const FILE = "agent-settings.jsonl";
const MAX_NAME = 32;
const MAX_GOAL = 280;
const MAX_VOICE = 200;

export const RISK_LEVELS = ["conservative", "balanced", "aggressive"] as const;
export const STYLES = ["concise", "balanced", "deep"] as const;
export const FOCUS_AREAS = ["market-making", "yield", "directional", "research"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type Style = (typeof STYLES)[number];
export type FocusArea = (typeof FOCUS_AREAS)[number];

export interface AgentSettings {
  name?: string;
  riskAppetite?: RiskLevel;
  focus?: FocusArea[];
  style?: Style;
  goal?: string;
  /**
   * How the agent should SOUND. `style` is length; this is character: dry and
   * skeptical, warm and patient, blunt. Free text because a fixed list of
   * personalities is exactly the thing people want to escape, and capped short
   * because a paragraph here is really an instruction in disguise.
   */
  voice?: string;
  /** Opt-in: this wallet's agent may speak in the public agent-to-agent feed.
   *  A user's agent speaks for a real person, so it is absent (not false) until
   *  they turn it on themselves, and nothing else may set it. */
  joinSwarm?: boolean;
}

/** Single short line, no control chars, capped. Shared by name + goal so no
 *  free-text field can inject newlines/instructions into the persona prompt. */
function cleanText(raw: unknown, cap: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
  return cleaned.length ? cleaned : null;
}

/**
 * A display name, held to a stricter standard than the other free text.
 *
 * Name is the one field that LEAVES its owner. It is published on the public
 * swarm page, and it is interpolated into OTHER agents' prompts ("you are X,
 * talking to an agent named Y"), so a name is untrusted text that reaches
 * strangers and third-party models. goal and voice only ever reach the agent
 * their owner configured.
 *
 * So markup and prompt punctuation come out. React renders our own surfaces as
 * text nodes and is not the worry; the worry is 32 characters of instruction
 * shaped like a name landing inside somebody else's system prompt, and any
 * future consumer of the public feed that is less careful than we are.
 */
export function sanitizeName(raw: unknown): string | null {
  const cleaned = cleanText(raw, MAX_NAME);
  if (cleaned === null) return null;
  const stripped = cleaned
    .replace(/[<>{}[\]\\`|]/g, "") // markup and prompt-fence characters
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length ? stripped : null;
}

/**
 * Validate a partial settings patch from an untrusted request. Returns the
 * cleaned patch (only the fields present and valid), or an error string. A
 * present-but-invalid field is rejected rather than silently dropped, so the UI
 * gets honest feedback.
 */
export function sanitizeSettings(patch: unknown): { settings: Partial<AgentSettings> } | { error: string } {
  if (!patch || typeof patch !== "object") return { error: "invalid settings" };
  const p = patch as Record<string, unknown>;
  const out: Partial<AgentSettings> = {};

  if ("name" in p) {
    const name = sanitizeName(p.name);
    if (!name) return { error: "name must be 1 to 32 usable characters" };
    out.name = name;
  }
  if ("riskAppetite" in p) {
    if (!RISK_LEVELS.includes(p.riskAppetite as RiskLevel)) return { error: `riskAppetite must be one of: ${RISK_LEVELS.join(", ")}` };
    out.riskAppetite = p.riskAppetite as RiskLevel;
  }
  if ("style" in p) {
    if (!STYLES.includes(p.style as Style)) return { error: `style must be one of: ${STYLES.join(", ")}` };
    out.style = p.style as Style;
  }
  if ("focus" in p) {
    if (!Array.isArray(p.focus) || p.focus.some((f) => !FOCUS_AREAS.includes(f as FocusArea)))
      return { error: `focus must be a subset of: ${FOCUS_AREAS.join(", ")}` };
    out.focus = [...new Set(p.focus as FocusArea[])]; // dedupe, order-insensitive
  }
  if ("goal" in p) {
    // Empty goal clears it; otherwise clean + cap.
    out.goal = p.goal === "" || p.goal == null ? "" : cleanText(p.goal, MAX_GOAL) ?? "";
  }

  if ("voice" in p) {
    out.voice = p.voice === "" || p.voice == null ? "" : cleanText(p.voice, MAX_VOICE) ?? "";
  }
  if ("joinSwarm" in p) {
    // Strictly boolean: consent to appear in a public feed is never inferred
    // from a truthy string or a 1.
    if (typeof p.joinSwarm !== "boolean") return { error: "joinSwarm must be true or false" };
    out.joinSwarm = p.joinSwarm;
  }

  if (Object.keys(out).length === 0) return { error: "no valid settings provided" };
  return { settings: out };
}

/** Latest settings per wallet, folded from the append-only file in one pass.
 *  Shared by the single-wallet read and the every-wallet read so the two can
 *  never disagree about which row wins.
 *
 *  Cached on the file's stat: this is read on every chat turn (twice: the
 *  display name and the persona) and on every public swarm feed request, which
 *  made it the hottest synchronous file read in the process. */
const settingsView = ledgerView<Map<string, AgentSettings>>(FILE, (rows) => {
  const out = new Map<string, AgentSettings>();
  for (const r of rows as Array<{ address?: unknown; settings?: unknown }>) {
    const a = String(r.address ?? "").toLowerCase();
    if (a && r.settings && typeof r.settings === "object") out.set(a, r.settings as AgentSettings);
  }
  return out;
});

/** Drop the parsed view (tests, and anything that rewrites the file). */
export function resetSettingsCache(): void {
  settingsView.reset();
}

// The cached map is shared, so both readers hand out a COPY. Callers previously
// got a freshly parsed object every time and are entitled to keep treating what
// they get as theirs; one object spread is nothing next to reparsing the file.
/** This wallet's current settings (latest write wins), or {} if none. */
export function getAgentSettings(address: string): AgentSettings {
  const found = settingsView.get().get(address.toLowerCase());
  return found ? { ...found } : {};
}

/** Every wallet that has ever written settings, with its current values. The
 *  read side of anything that has to ask "which wallets opted into X". */
export function allAgentSettings(): Array<{ address: string; settings: AgentSettings }> {
  return [...settingsView.get().entries()].map(([address, settings]) => ({ address, settings: { ...settings } }));
}

/** Merge a validated patch into this wallet's settings and persist (append-only). */
export function updateAgentSettings(address: string, patch: Partial<AgentSettings>): AgentSettings {
  const merged = { ...getAgentSettings(address), ...patch };
  // A cleared goal ("") should drop the key rather than persist an empty string.
  if (merged.goal === "") delete merged.goal;
  if (merged.voice === "") delete merged.voice;
  appendLedger(FILE, { address: address.toLowerCase(), settings: merged, at: Date.now() });
  return merged;
}
