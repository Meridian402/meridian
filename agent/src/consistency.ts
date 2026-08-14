// The consistency scoreboard: the desk's daily record, derived entirely from
// what is already recorded (book marks and the decision journal), computed at
// read time. Nothing here touches trading. The claim this backs is the honest
// one: fee income compounds daily while the worst any day can do is bounded,
// and every number is checkable.
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { QUARANTINED } from "./bookSnapshot.js";

const BOOK_PATH = dataPath("book-snapshots.jsonl");
const JOURNAL_PATH = dataPath("meme-rotations.jsonl");
const DAILY_LOSS_LIMIT_USD = Number(process.env.MERIDIAN_DAILY_LOSS_LIMIT_USD ?? 75);

export interface DayRecord {
  date: string;
  lpFeesUsd: number;
  bookOpen: number;
  bookClose: number;
  /** Deepest intraday fall below that day's running high-water mark. */
  maxDrawdownUsd: number;
  stops: number;
  collects: number;
}

let cache: { at: number; body: { days: DayRecord[]; summary: Record<string, number | string> } } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export function consistencyBoard() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;

  const marks: { ts: number; book: number; feesUsd?: number }[] = [];
  if (existsSync(BOOK_PATH)) {
    for (const line of readFileSync(BOOK_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as { ts: number; book: number; feesUsd?: number };
        if (!Number.isFinite(p.book)) continue;
        // The same quarantine the chart honors: marks from a known-broken
        // gauge must not resurface here as a phantom record drawdown.
        if (QUARANTINED.some(([a, b]) => p.ts >= a && p.ts <= b)) continue;
        marks.push(p);
      } catch {
        /* skip bad line */
      }
    }
  }
  marks.sort((a, b) => a.ts - b.ts);

  // THE TRANSIENT-CRATER FILTER. A restart or half-failed read can print one
  // or two marks hundreds of dollars below reality (a boot catches the wallet
  // mid-scan, positions read as absent), and a single such mark became the
  // published "worst intraday drawdown $285" for 2026-08-12 — a number no
  // market produced. The tell is shape: a real drawdown persists across many
  // consecutive 2-minute marks; an artifact plunges and fully recovers within
  // a couple. Drop dips of <= 3 marks that fall > $120 below the level both
  // BEFORE and AFTER them: $120 is the desk's own hard daily floor, so a
  // "move" this size that fully round-trips inside six minutes is not a market
  // event at this book size — it is a bad read. Raw lines stay in the ledger;
  // they are just never served as a record.
  const CRATER_USD = 120;
  const CRATER_RUN = 3;
  const books: typeof marks = [];
  for (let i = 0; i < marks.length; i++) {
    const prev = books[books.length - 1];
    if (prev && prev.book - marks[i].book > CRATER_USD) {
      let j = i;
      while (j < marks.length && j - i < CRATER_RUN && prev.book - marks[j].book > CRATER_USD) j++;
      if (j < marks.length && j - i <= CRATER_RUN && prev.book - marks[j].book <= CRATER_USD) {
        i = j - 1; // the dip healed within a couple of marks: artifact, skip it
        continue;
      }
    }
    books.push(marks[i]);
  }

  // Days are US EASTERN, not UTC (2026-08-14): the operator lives on ET and
  // so does the market this desk trades around. Bucketing by UTC rolled the
  // record's "day" at 8pm Eastern, so every morning the current row already
  // carried most of a day of numbers that felt like yesterday's. en-CA
  // formatting yields YYYY-MM-DD, keeping the keys sortable and stable.
  const dayKey = (ts: number) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const byDay = new Map<string, { fees: number[]; books: number[] }>();
  for (const p of books) {
    const d = dayKey(p.ts);
    const rec = byDay.get(d) ?? byDay.set(d, { fees: [], books: [] }).get(d)!;
    if (Number.isFinite(p.feesUsd)) rec.fees.push(p.feesUsd!);
    rec.books.push(p.book);
  }

  const stopsByDay = new Map<string, number>();
  const collectsByDay = new Map<string, number>();
  if (existsSync(JOURNAL_PATH)) {
    for (const line of readFileSync(JOURNAL_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { ts: number; kind?: string };
        const d = new Date(e.ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        if (e.kind === "stop-loss") stopsByDay.set(d, (stopsByDay.get(d) ?? 0) + 1);
        if (e.kind === "collect") collectsByDay.set(d, (collectsByDay.get(d) ?? 0) + 1);
      } catch {
        /* skip */
      }
    }
  }

  const days: DayRecord[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, r]) => {
      // Fee income within the day: the cumulative series' rise. Sum of positive
      // steps, not last-minus-first, so a mid-day counter reset (a deploy era
      // artifact) never counts as negative earning.
      let fees = 0;
      for (let i = 1; i < r.fees.length; i++) {
        const step = r.fees[i] - r.fees[i - 1];
        if (step > 0) fees += step;
      }
      let hwm = -Infinity;
      let maxDd = 0;
      for (const b of r.books) {
        if (b > hwm) hwm = b;
        else if (hwm - b > maxDd) maxDd = hwm - b;
      }
      return {
        date,
        lpFeesUsd: Math.round(fees * 100) / 100,
        bookOpen: Math.round(r.books[0] * 100) / 100,
        bookClose: Math.round(r.books[r.books.length - 1] * 100) / 100,
        maxDrawdownUsd: Math.round(maxDd * 100) / 100,
        stops: stopsByDay.get(date) ?? 0,
        collects: collectsByDay.get(date) ?? 0,
      };
    });

  const totalFees = days.reduce((s, d) => s + d.lpFeesUsd, 0);
  const body = {
    days,
    summary: {
      daysLive: days.length,
      totalLpFeesUsd: Math.round(totalFees * 100) / 100,
      bestFeeDayUsd: Math.round(Math.max(0, ...days.map((d) => d.lpFeesUsd)) * 100) / 100,
      worstDrawdownUsd: Math.round(Math.max(0, ...days.map((d) => d.maxDrawdownUsd)) * 100) / 100,
      dailyLossLimitUsd: DAILY_LOSS_LIMIT_USD,
    },
  };
  cache = { at: Date.now(), body };
  return body;
}
