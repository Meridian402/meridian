// Retrieval-augmented context, piece 2 of the learning plan (piece 1 is the
// shadow model in harness.ts). No weights move here: this is Merd remembering
// his own operating history. The desk journal and the incident log are parsed
// into small tagged items; a query ("CASHCAT, stop-loss, night") pulls the
// most similar PAST moments, which the narrator and console inject as real
// memory. Only recorded events are recallable, so the memory cannot invent.
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../dataDir.js";

const JOURNAL_PATH = dataPath("meme-rotations.jsonl");
const DESK_MD_URL = new URL("../../DESK.md", import.meta.url);

export interface RecallItem {
  ts: number;
  line: string;
  tags: string[];
}

export interface RecallQuery {
  pool?: string;
  kind?: string;
  /** UTC hour 0-23; buckets to "night" (00-08, the thin hours) or "day". */
  hour?: number;
}

const hourTag = (h: number) => (h >= 0 && h < 8 ? "night" : "day");

/** Tag overlap score, pool matches weighted heaviest. Pure, for tests. */
export function scoreRecall(itemTags: string[], queryTags: string[]): number {
  let s = 0;
  for (const t of queryTags) {
    if (!itemTags.includes(t)) continue;
    s += t.startsWith("pool:") ? 3 : t.startsWith("kind:") ? 2 : 1;
  }
  return s;
}

export function queryTags(q: RecallQuery): string[] {
  const tags: string[] = [];
  if (q.pool) tags.push(`pool:${q.pool.toLowerCase()}`);
  if (q.kind) tags.push(`kind:${q.kind}`);
  if (q.hour != null) tags.push(hourTag(q.hour));
  return tags;
}

function journalItems(): RecallItem[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  const items: RecallItem[] = [];
  for (const raw of readFileSync(JOURNAL_PATH, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const e = JSON.parse(raw) as Record<string, unknown>;
      const ts = Number(e.ts ?? 0);
      if (!ts) continue;
      const kind = String(e.kind ?? "rotate");
      const pool = String(e.pool ?? e.venue ?? e.from ?? "").toUpperCase();
      const when = new Date(ts);
      const stamp = `${when.toISOString().slice(5, 10)} ${when.toISOString().slice(11, 16)}`;
      let line: string | null = null;
      if (kind === "stop-loss")
        line = `${stamp} ${pool}: cut at market (${String(e.reason ?? "")}), sold ${Number(e.tokensSold ?? 0).toFixed(0)} tokens for ${Number(e.ethRealized ?? 0).toFixed(4)} eth`;
      else if (kind === "collect")
        line = `${stamp} ${pool}: collected fees${Number(e.ethBankedToTreasury ?? 0) > 0 ? `, banked ${Number(e.ethBankedToTreasury).toFixed(4)} eth` : ""}`;
      else if (kind === "migrate") line = `${stamp} moved capital ${String(e.from ?? "?")} -> ${String(e.to ?? "?")} (${String(e.reason ?? "")})`;
      else if (kind === "expand") line = `${stamp} entered ${pool} with ${Number(e.ethIn ?? 0).toFixed(3)} eth`;
      else if (e.driftPctPerHr != null) line = `${stamp} ${pool}: re-quoted at drift ${Number(e.driftPctPerHr).toFixed(1)}%/hr`;
      if (!line) continue;
      const tags = [`pool:${pool.toLowerCase()}`, `kind:${kind}`, hourTag(when.getUTCHours())];
      const drift = Number(e.driftPctPerHr ?? NaN);
      if (Number.isFinite(drift)) tags.push(drift > 8 ? "dumping" : drift < -8 ? "pumping" : "chop");
      items.push({ ts, line, tags });
    } catch {
      /* skip bad line */
    }
  }
  return items;
}

function incidentItems(): RecallItem[] {
  try {
    const raw = readFileSync(DESK_MD_URL, "utf8");
    const start = raw.indexOf("## Incident log");
    if (start < 0) return [];
    const section = raw.slice(start, raw.indexOf("\n## ", start + 10) > 0 ? raw.indexOf("\n## ", start + 10) : undefined);
    const items: RecallItem[] = [];
    for (const b of section.split(/\n- /).slice(1)) {
      const line = `incident: ${b.replace(/\s+/g, " ").trim().slice(0, 400)}`;
      const tags = ["kind:incident"];
      for (const m of line.toLowerCase().matchAll(/\b(cashcat|stonkbroker|bourse|unifrog|merd)\b/g)) tags.push(`pool:${m[1]}`);
      items.push({ ts: 0, line, tags: [...new Set(tags)] });
    }
    return items;
  } catch {
    return [];
  }
}

/** The top-k most similar recorded moments for a query, newest first among
 *  equals. Incidents (distilled lessons) rank above raw journal lines at equal
 *  score by their length of consequence, cheaply: a +1 bonus. */
export function recall(q: RecallQuery, k = 4): string[] {
  const qt = queryTags(q);
  const scored = [...journalItems(), ...incidentItems()]
    .map((it) => ({ it, s: scoreRecall(it.tags, qt) + (it.tags.includes("kind:incident") ? 1 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.it.ts - a.it.ts);
  return scored.slice(0, k).map((x) => x.it.line);
}
