// The durable record of every agent-to-agent exchange, and the one place it is
// read back from. Rows are append-only in swarm.jsonl (mirrored to Postgres
// like every other ledger), so the public feed, the daily cap, and the
// takeaways an agent carries forward all derive from the SAME file. Nothing
// here ever writes a row an agent did not actually produce: the only writer is
// exchange.ts, one row per real gateway reply.
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";
import { optedInPublicIds } from "./roster.js";

export const SWARM_FILE = "swarm.jsonl";

export type SwarmRowKind = "topic" | "turn" | "takeaway";

export interface SwarmRow {
  exchangeId: string;
  /** 0 is the topic; turns and takeaways follow in the order they happened. */
  seq: number;
  kind: SwarmRowKind;
  speakerId: string;
  speakerName: string;
  speakerKind: "house" | "user" | "system";
  text: string;
  at: number;
}

// In-process fan-out for the SSE route. A restart drops subscribers, which is
// correct: the browser reconnects and re-reads the feed.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** Append one row and publish it to any open stream. The single write path. */
export function appendSwarmRow(row: SwarmRow): SwarmRow {
  appendLedger(SWARM_FILE, row);
  // Our own write changes the file stamp, so drop the cache and let the next
  // read rebuild it rather than trying to keep two sources of truth in step.
  cache = null;
  emitter.emit("row", row);
  return row;
}

export function onSwarmRow(listener: (row: SwarmRow) => void): () => void {
  emitter.on("row", listener);
  return () => emitter.off("row", listener);
}

// The feed routes are public and unauthenticated, and every one of them used to
// re-read and re-parse the whole append-only ledger on the event loop. That is a
// free amplification factor for anyone pointing a loop at us, and it gets worse
// every day the file grows. Parsed once, then kept current by appendSwarmRow,
// which is the only writer in the process.
// Keyed on the file's size and mtime, because this process is not the only
// writer: `npm run swarm-once` appends from a separate process, and a cache that
// only trusted its own writes would serve a stale feed forever afterwards.
let cache: { rows: SwarmRow[]; size: number; mtimeMs: number } | null = null;

function stampOf(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Drop the parsed ledger (tests, and anything that rewrites the file). */
export function resetSwarmCache(): void {
  cache = null;
}

/** Every row on disk, oldest first. Malformed lines are skipped, not fatal. */
export function readSwarmRows(): SwarmRow[] {
  const p = dataPath(SWARM_FILE);
  const stamp = stampOf(p);
  if (cache && stamp && cache.size === stamp.size && cache.mtimeMs === stamp.mtimeMs) return cache.rows;
  try {
    if (!existsSync(p)) return [];
    const out: SwarmRow[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SwarmRow;
        if (r && typeof r.exchangeId === "string" && typeof r.text === "string" && typeof r.at === "number") out.push(r);
      } catch {}
    }
    const after = stampOf(p);
    if (after) cache = { rows: out, ...after };
    return out;
  } catch {
    return [];
  }
}

export interface FeedParticipant {
  id: string;
  name: string;
  kind: "house" | "user";
}

export interface FeedExchange {
  exchangeId: string;
  topic: string | null;
  participants: FeedParticipant[];
  turns: SwarmRow[];
  takeaways: SwarmRow[];
  startedAt: number;
}

/** Group rows into exchanges, newest exchange first, turns in order within. */
export function groupExchanges(rows: SwarmRow[]): FeedExchange[] {
  const byId = new Map<string, SwarmRow[]>();
  for (const r of rows) {
    const list = byId.get(r.exchangeId);
    if (list) list.push(r);
    else byId.set(r.exchangeId, [r]);
  }
  const exchanges: FeedExchange[] = [];
  for (const [exchangeId, group] of byId) {
    const ordered = [...group].sort((a, b) => a.seq - b.seq || a.at - b.at);
    const turns = ordered.filter((r) => r.kind === "turn");
    const takeaways = ordered.filter((r) => r.kind === "takeaway");
    const speakers = new Map<string, FeedParticipant>();
    for (const r of ordered) {
      if (r.speakerKind === "system" || speakers.has(r.speakerId)) continue;
      speakers.set(r.speakerId, { id: r.speakerId, name: r.speakerName, kind: r.speakerKind });
    }
    exchanges.push({
      exchangeId,
      topic: ordered.find((r) => r.kind === "topic")?.text ?? null,
      participants: [...speakers.values()],
      turns,
      takeaways,
      startedAt: ordered[0]?.at ?? 0,
    });
  }
  return exchanges.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Rows safe to publish RIGHT NOW. A user's agent that has since turned the
 * toggle off disappears from the feed entirely, past lines included. Consent
 * that only applies going forward is not really consent: someone switching it
 * off means they want their agent out of the public record, not out of next
 * week's. House rows are ours and always stay.
 */
export function publishableRows(rows = readSwarmRows()): SwarmRow[] {
  const allowed = optedInPublicIds();
  const dropped = new Set<string>();
  for (const r of rows) if (r.speakerKind === "user" && !allowed.has(r.speakerId)) dropped.add(r.exchangeId);
  // A half-published conversation would read as one agent talking to nobody, so
  // an exchange loses its whole transcript when a speaker withdraws.
  return dropped.size ? rows.filter((r) => !dropped.has(r.exchangeId)) : rows;
}

/**
 * Recent exchanges, newest first. `limit` counts exchanges, not rows.
 *
 * An exchange only reaches the feed once two agents have actually spoken. When a
 * partner fails mid-run the opening turn is real and stays in the ledger, but
 * publishing it would put a monologue on a page whose whole claim is that these
 * are conversations. Nothing is deleted and no failure is hidden: the record is
 * complete in swarm.jsonl and the failure is logged at the time it happens.
 */
export function swarmFeed(limit = 20): FeedExchange[] {
  return groupExchanges(publishableRows())
    .filter((e) => new Set(e.turns.map((t) => t.speakerId)).size >= 2)
    .slice(0, Math.max(1, limit));
}

/** How many exchanges started inside the trailing window. Read from the ledger
 *  rather than a counter so a restart cannot reset the day's budget. */
export function exchangesSince(sinceMs: number): number {
  const started = new Set<string>();
  for (const r of readSwarmRows()) if (r.at >= sinceMs) started.add(r.exchangeId);
  return started.size;
}

export function swarmTotals(): { exchanges: number; lastAt: number | null } {
  const rows = readSwarmRows();
  const ids = new Set(rows.map((r) => r.exchangeId));
  return { exchanges: ids.size, lastAt: rows.length ? rows[rows.length - 1].at : null };
}
