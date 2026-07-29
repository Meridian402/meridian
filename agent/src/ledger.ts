// Phase 2 of the data layer: row-level ledger in Postgres.
//
// `appendLedger(file, row)` is the ONE way durable JSONL records get written:
//   1. synchronous append to the local file — this REMAINS the source of truth
//      every read path uses, so money-path reads (circuit breaker, x402 replay
//      set, cooldowns) stay sync, local, and fail-safe with zero new
//      dependencies;
//   2. fire-and-forget INSERT of the same row into `meridian_ledger` — a
//      real-time queryable mirror (RPO ~0 for the books, vs the 5-min snapshot
//      mirror in backup.ts, which stays on as the whole-file restore path).
//
// On boot, `initLedger()` backfills any file whose history isn't in Postgres
// yet (count=0 for that file), so the table holds the FULL record from genesis,
// and local trimming (wallet-ledger 48h compaction, basis-log line cap) no
// longer discards history — Postgres keeps the archive.
//
// Every Postgres touch is best-effort: a DB hiccup can never fail or slow a
// write. Worst case rows land only in the file and the snapshot mirror covers
// them. Duplicate rows in the mirror (e.g. the tiny boot race between backfill
// and a live write) are acceptable — it is a mirror, not the source of truth.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { getPool } from "./db.js";

const TABLE = "meridian_ledger";

// The row-based (JSONL) durable files. The whole-JSON state docs
// (lp-guard-state.json, position-state.json, rwa-universe.json) are not rows —
// the snapshot mirror covers those.
const LEDGER_FILES = [
  "accounts.jsonl",
  "agent-settings.jsonl",
  "basis-log.jsonl",
  "bounties.jsonl",
  "credits.jsonl",
  "equity-snapshots.jsonl",
  "executions.jsonl",
  "fleets.jsonl",
  "lighter-log.jsonl",
  "lp-opportunities.jsonl",
  "lp-positions.jsonl",
  "reservations.jsonl",
  "revenue.jsonl",
  "swarm.jsonl",
  "user-agents.jsonl",
  "wallet-ledger.jsonl",
  "x402-used.jsonl",
  "yield-log.jsonl",
];

let ready = false;
const pending: Array<[string, string]> = [];
const status = { ready: false, inserted: 0, failed: 0, backfilled: 0, queued: 0 };

function insertRow(file: string, json: string): void {
  const p = getPool();
  if (!p) return;
  p.query(`INSERT INTO ${TABLE} (file, row) VALUES ($1, $2::jsonb)`, [file, json])
    .then(() => { status.inserted++; })
    .catch(() => { status.failed++; });
}

/** The one write path for durable JSONL records: sync file append + async PG mirror. */
export function appendLedger(file: string, row: object): void {
  const json = JSON.stringify(row);
  appendFileSync(dataPath(file), json + "\n"); // source of truth, unchanged semantics
  if (!getPool()) return;
  if (!ready) {
    if (pending.length < 5000) { pending.push([file, json]); status.queued = pending.length; }
    return;
  }
  insertRow(file, json);
}

export function ledgerStatus() {
  return { ...status, queued: pending.length };
}

/** Create the table, backfill missing history, then start draining live rows. */
export async function initLedger(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.error("[ledger] DATABASE_URL not set — row mirror disabled (files only)");
    return;
  }
  try {
    await p.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         id bigserial PRIMARY KEY,
         file text NOT NULL,
         row jsonb NOT NULL,
         at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await p.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_file_at ON ${TABLE} (file, at)`);

    // One-time backfill per file: only when Postgres has nothing for it, so
    // restarts never duplicate history. `at` is insert-time for backfilled rows;
    // the rows' own ts/at fields inside the jsonb carry the real event times.
    for (const f of LEDGER_FILES) {
      const local = dataPath(f);
      if (!existsSync(local)) continue;
      const { rows } = await p.query<{ n: string }>(`SELECT count(*) AS n FROM ${TABLE} WHERE file = $1`, [f]);
      if (Number(rows[0]?.n ?? 0) > 0) continue;
      const lines = readFileSync(local, "utf8").split("\n").filter((l) => l.trim());
      for (let i = 0; i < lines.length; i += 500) {
        const batch = lines.slice(i, i + 500).filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });
        if (!batch.length) continue;
        const values = batch.map((_, j) => `($1, $${j + 2}::jsonb)`).join(",");
        await p.query(`INSERT INTO ${TABLE} (file, row) VALUES ${values}`, [f, ...batch]);
        status.backfilled += batch.length;
      }
    }

    ready = true;
    status.ready = true;
    for (const [f, json] of pending.splice(0)) insertRow(f, json);
    console.error(`[ledger] row mirror active (backfilled ${status.backfilled} historical rows)`);
  } catch (err) {
    console.error(`[ledger] init failed (files unaffected, snapshot mirror still covers): ${err instanceof Error ? err.message : err}`);
  }
}
