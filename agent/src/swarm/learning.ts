// The half of the feature that is not theatre: what an agent carries out of a
// conversation. After every exchange each speaker states, in one sentence, the
// single thing it takes away. Those sentences are stored per agent and injected
// back into that agent's own instruction, so the next conversation starts from
// what the last one settled.
//
// Two hard limits, both deliberate. Only the most recent few are kept, because
// an agent that accumulates every conclusion it has ever reached stops being
// steerable. And the injected block is truncated to a fixed character budget,
// because an instruction that grows with usage is an instruction that
// eventually costs more than the reply it produces.
import { readSwarmRows } from "./feed.js";

const DEFAULT_KEEP = 5;
const MAX_KEEP = 20;
const MAX_INJECTED_CHARS = 600;

export interface Takeaway {
  exchangeId: string;
  text: string;
  at: number;
}

/** How many takeaways per agent survive. Env-tunable, hard-bounded. */
export function takeawayLimit(): number {
  const raw = Number(process.env.SWARM_TAKEAWAYS_PER_AGENT ?? DEFAULT_KEEP);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_KEEP;
  return Math.min(Math.floor(raw), MAX_KEEP);
}

/** This agent's most recent takeaways, newest first, capped at the limit. */
export function takeawaysFor(agentId: string): Takeaway[] {
  const mine = readSwarmRows().filter((r) => r.kind === "takeaway" && r.speakerId === agentId && r.text.trim());
  return mine
    .slice(-takeawayLimit())
    .reverse()
    .map((r) => ({ exchangeId: r.exchangeId, text: r.text.trim(), at: r.at }));
}

/**
 * Trim a list of takeaway sentences to the injection budget, whole lines only:
 * half a sentence in a persona reads as a bug to the agent reading it.
 * Exported for the test, and so the budget is enforced in exactly one place.
 */
export function fitTakeaways(texts: string[], budget = MAX_INJECTED_CHARS): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const t of texts) {
    const line = `- ${t.replace(/\s+/g, " ").trim()}`;
    if (!line.trim() || line.length > budget) continue;
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
}

/**
 * The block appended to an agent's instruction. Empty string when the agent has
 * never been in an exchange, so a fresh agent's persona is untouched.
 */
export function learningSection(agentId: string): string {
  const lines = fitTakeaways(takeawaysFor(agentId).map((t) => t.text));
  if (!lines.length) return "";
  return [
    `What you have learned from talking to other agents (your own conclusions from those conversations, most recent first). Treat them as yours, build on them, and drop one the moment better evidence turns up:`,
    ...lines,
  ].join("\n");
}
