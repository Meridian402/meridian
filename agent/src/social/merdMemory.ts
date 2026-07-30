// Per-agent continuity.
//
// He had none. merd-memory/ was empty, merd-decisions.jsonl was written and
// never read back, and the only history that reached the prompt was his last 12
// posts framed as a blocklist ("do NOT repeat them or their themes"). So every
// cycle composed a stranger who happened to share a voice doc: no thread he was
// pulling on, no call he had made, nothing he had been wrong about. Personality
// is continuity, and 27 disconnected observations is not a person.
//
// This is a journal he keeps for himself. It is NEVER published: it is the
// private half of thinking out loud, fed back next cycle so he can build on a
// thought instead of restarting it. Kept as JSONL under the data dir so the
// existing Postgres mirror backs it up with everything else.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";

// One journal per persona. The X voice and the executive are different agents
// with different jobs, so they must not share a memory: the copywriter
// remembering a funding decision, or Merd remembering a joke he made about
// Bloom Energy, would blur exactly the separation this split exists to create.
const journalFile = (agent: string) => `${agent}-journal.jsonl`;

export interface JournalEntry {
  at: number;
  /** What he chose to do that cycle — useful context for the next one. */
  decision: "post" | "hold";
  /** His own private note: what he is tracking, what he thinks, what he got wrong. */
  note: string;
}

/** Append one cycle's note. Silent on failure — a journal write must never cost a post. */
export function remember(agent: string, entry: Omit<JournalEntry, "at">): void {
  const note = entry.note.trim().slice(0, 400);
  if (!note) return;
  try {
    appendLedger(journalFile(agent), { at: Date.now(), decision: entry.decision, note });
  } catch {
    /* non-fatal */
  }
}

/** The last `limit` notes, oldest first, so the prompt reads as a timeline. */
export function recall(agent: string, limit = 8): JournalEntry[] {
  const path = dataPath(journalFile(agent));
  if (!existsSync(path)) return [];
  const rows: JournalEntry[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as JournalEntry;
        if (r?.note) rows.push(r);
      } catch {
        /* skip a malformed line rather than lose the journal */
      }
    }
  } catch {
    return [];
  }
  return rows.slice(-limit);
}

/**
 * The journal rendered for a prompt: a timeline of what he has been thinking,
 * with rough ages so "two days ago" is available to him as a thought.
 */
export function recallForPrompt(agent: string, limit = 8): string {
  const rows = recall(agent, limit);
  if (!rows.length) return "";
  const now = Date.now();
  const ago = (ts: number) => {
    const h = (now - ts) / 3600_000;
    if (h < 1) return "just now";
    if (h < 24) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };
  return rows.map((r) => `- (${ago(r.at)}) ${r.note}`).join("\n");
}

/**
 * The curated "what shipped" feed (merd-shipped.md), newest first.
 *
 * Engineering writes each line in user-facing terms; Merd decides whether it is
 * worth saying. This replaces the raw git-log feed that was removed after he
 * narrated internal engineering in public — the failure there was feeding him
 * commit subjects, not the idea of him knowing what shipped.
 */
export function recentlyShipped(limit = 4): string[] {
  try {
    const raw = readFileSync(new URL("../../merd-shipped.md", import.meta.url), "utf8");
    const body = raw.split(/^##\s+Entries\s*$/im)[1] ?? "";
    return body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d{4}-\d{2}-\d{2}\s+[—-]\s+\S/.test(l))
      .slice(0, limit)
      .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}\s+[—-]\s+/, "").trim());
  } catch {
    return []; // no feed is fine: he simply has nothing shipped to mention
  }
}

/**
 * A model reply that may carry a private note alongside the public text.
 *
 * Asking for a second model call per cycle just to journal would double the
 * cost of every post, so the note rides along in one response. Parsing is
 * deliberately forgiving: an unlabelled reply is treated as pure public text,
 * exactly as before, so a model that ignores the format still posts normally
 * rather than emitting "POST:" onto the timeline.
 */
export function splitNote(raw: string): { text: string; note: string } {
  const s = (raw ?? "").trim();
  const noteMatch = s.match(/^[\s>*-]*NOTE\s*:\s*([\s\S]*)$/im);
  const note = noteMatch ? noteMatch[1].trim() : "";
  let text = note ? s.slice(0, noteMatch!.index).trim() : s;

  // The POST: marker shows up in two shapes and only one of them was handled.
  //
  // Leading, "POST: <tweet>", is the template being followed: the label is
  // noise and the tweet is what follows.
  //
  // Mid-text is the shape that actually shipped. The model writes the tweet as
  // prose, then repeats a labelled version of its first sentence underneath.
  // The old anchored strip could never match that, so the marker AND the echo
  // went to the timeline: a real post went out ending "... POST: four reads
  // running now, maple credit has ticked 5.6 to 5.4 to 5.2 to 5.1." It also
  // pushed the length past the 500 cap, so the next three cycles were skipped
  // outright and the account went quiet for a day. Everything from the marker
  // on is the echo, so the tweet is what came before it.
  const leading = text.match(/^[\s>*-]*POST\s*:\s*/i);
  if (leading) {
    text = text.slice(leading[0].length).trim();
  } else {
    const echo = text.search(/(?:^|\s)POST\s*:/i);
    if (echo >= 0) text = text.slice(0, echo).trim();
  }
  return { text, note };
}
