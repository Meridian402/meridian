// Durable-state backup: dual-homes every file the backend treats as a database
// (the JSONL ledgers + JSON state on the single Railway volume) into Postgres,
// and restores them on boot if the volume ever comes up empty. This closes the
// "one volume, no backups" single point of failure WITHOUT touching any money
// path — the files stay the working store; Postgres is the mirror.
//
//   · every 5 min (and once at boot): upsert each file's content, skipped when
//     the content hash hasn't changed so idle files cost nothing
//   · on boot, BEFORE the first snapshot: any file that exists in Postgres but
//     is missing/empty locally is written back — a fresh volume self-heals
//   · no DATABASE_URL → logs once and no-ops (local dev unaffected)
//   · every operation is best-effort: a backup failure must never crash or
//     block the operator
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type pg from "pg";
import { dataPath } from "./dataDir.js";
import { getPool } from "./db.js";

const TABLE = "meridian_file_snapshots";
const INTERVAL_MS = Number(process.env.MERIDIAN_BACKUP_INTERVAL_MS ?? 5 * 60 * 1000);

// The full durable-file universe (everything written via dataPath).
const FILES = [
  "accounts.jsonl",
  "agent-settings.jsonl",
  "basis-log.jsonl",
  "bounties.jsonl",
  "equity-snapshots.jsonl",
  "executions.jsonl",
  "fleets.jsonl",
  "lighter-log.jsonl",
  "lp-guard-state.json",
  "lp-opportunities.jsonl",
  "lp-positions.jsonl",
  // Agent continuity. A journal IS that agent's memory — losing it resets the
  // persona to a stranger who happens to share a voice doc. One per agent:
  // the copywriter owns the X account, Merd owns the operation, and they must
  // not share a memory. x-posts is what the cadence floor and the similarity
  // dedupe read, so losing that means stacked or repeated posts, not just a gap.
  "copywriter-journal.jsonl",
  "merd-journal.jsonl",
  "x-posts.jsonl",
  "position-state.json",
  "reservations.jsonl",
  "revenue.jsonl",
  "rwa-universe.json",
  "user-agents.jsonl",
  "wallet-ledger.jsonl",
  "x402-used.jsonl",
  "yield-log.jsonl",
  // These four were written durably but had no way back.
  //
  // There are two lists: ledger.ts LEDGER_FILES decides what is mirrored row by
  // row into Postgres, and THIS one decides what can actually be restored, since
  // restoreMissing reads only the snapshot table and skips any filename it does
  // not recognise. A file in the first list and not this one looks backed up and
  // is not.
  //
  // credits.jsonl is every wallet's balance on a paid product, and swarm.jsonl
  // is the only record of what the agents have said in public. x-replies.jsonl
  // was in neither list. open-deploy-state.json is the marker that stops a
  // capped deploy plan running a second time, so losing it does not lose data,
  // it repeats a spend.
  "credits.jsonl",
  "swarm.jsonl",
  "x-replies.jsonl",
  "open-deploy-state.json",
  // Merd's memory, and it was in neither list.
  //
  // copywriter-journal.jsonl is the only copy of what Merd has concluded across
  // its whole run: the notes it writes to itself each cycle and reads back the
  // next one. The posting voice depends on it directly, because the callback form
  // ("i said i would watch whether X closed, it did not") is generated FROM these
  // entries. Lose the file and Merd does not just lose data, it loses continuity
  // and starts writing like it has never thought anything before, which is the
  // exact quality that makes it read as a person rather than a feed.
  //
  // x-posts.jsonl is the record of what actually published, which is also the
  // dedupe source that stops it repeating itself, and merd-decisions.jsonl is its
  // own log of post-versus-hold calls.
  "copywriter-journal.jsonl",
  "x-posts.jsonl",
  "merd-decisions.jsonl",
];

const lastHash = new Map<string, string>();
const status = { enabled: false, lastRunAt: 0, filesBackedUp: 0, restored: [] as string[], lastError: "" };

async function ensureTable(p: pg.Pool): Promise<void> {
  await p.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       file text PRIMARY KEY,
       content text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** Boot-time self-heal: pull back any file Postgres has that the volume lost. */
async function restoreMissing(p: pg.Pool): Promise<void> {
  const { rows } = await p.query<{ file: string; content: string }>(`SELECT file, content FROM ${TABLE}`);
  for (const r of rows) {
    if (!FILES.includes(r.file)) continue; // never restore a name we don't know
    const local = dataPath(r.file);
    const localEmpty = !existsSync(local) || readFileSync(local, "utf8").trim() === "";
    if (localEmpty && r.content.trim() !== "") {
      writeFileSync(local, r.content);
      status.restored.push(r.file);
      console.error(`[backup] RESTORED ${r.file} from Postgres (${r.content.length} bytes) — volume was missing it`);
    }
  }
}

async function snapshot(p: pg.Pool): Promise<void> {
  let count = 0;
  for (const f of FILES) {
    const local = dataPath(f);
    if (!existsSync(local)) continue;
    const content = readFileSync(local, "utf8");
    if (content.trim() === "") continue;
    const hash = createHash("sha256").update(content).digest("hex");
    if (lastHash.get(f) === hash) { count++; continue; } // unchanged — free
    await p.query(
      `INSERT INTO ${TABLE} (file, content, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (file) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [f, content],
    );
    lastHash.set(f, hash);
    count++;
  }
  status.lastRunAt = Date.now();
  status.filesBackedUp = count;
  status.lastError = "";
}

/** For /api/ops: is the mirror alive, when did it last run, what got restored. */
export function backupStatus() {
  return { ...status, restored: [...status.restored] };
}

export function startBackups(): void {
  const p = getPool();
  if (!p) {
    console.error("[backup] DATABASE_URL not set — Postgres mirror disabled (volume is the only copy)");
    return;
  }
  status.enabled = true;
  const run = async (first: boolean) => {
    try {
      if (first) {
        await ensureTable(p);
        await restoreMissing(p);
      }
      await snapshot(p);
      if (first) console.error(`[backup] Postgres mirror active: ${status.filesBackedUp} files, every ${INTERVAL_MS / 60000}min`);
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[backup] failed (will retry next cycle): ${status.lastError}`);
    }
  };
  void run(true);
  const timer = setInterval(() => void run(false), INTERVAL_MS);
  timer.unref?.();
}
