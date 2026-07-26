// Merd posting about Meridian, on his own, a few times a week.
//
// DRAFT-FIRST. This composes, filters and records a candidate every cycle, and
// only actually posts when X_LIVE === "true". Anything else writes the tweet to
// x-posts.jsonl and returns — so the voice can be read for a week before a
// single autonomous tweet exists.
//
// WHAT IT MUST NOT SAY:
//   MERD is built and unlaunched. The whole PoolKey is public in the repo and
//   v4's initialize is permissionless, so anyone who learns a launch is imminent
//   can open our pool first at a price of their choosing. The anti-sniper ramp
//   assumes bots do not know it is coming. Merd talking about the token, the
//   hook, the lock or the buyback hands both away.
//
//   That is not left to the prompt. Every candidate goes through
//   forbiddenReason(), which now blocks the ticker, contract addresses, contract
//   names, buyback-and-burn, launch mechanics, lock claims, deployment internals
//   and hook mechanics. A probe of nine plausible launch sentences found all
//   nine passed the ORIGINAL guards, which is why those rules exist and why they
//   are pinned as tests.
//
// WHY THE CADENCE IS SLOW:
//   An agent that posts because a timer fired sounds like a bot. This posts only
//   when it has something concrete and non-repetitive to say, drops the cycle
//   otherwise, and holds a hard floor between posts. Silence is the default.
import { composeMerdTweets, type MerdSignals } from "./merdVoice.js";
import { forbiddenReason, tooSimilar, repeatedStat, isJunk } from "./postGuards.js";
import { postTweet, xConfigured, xLive } from "./xClient.js";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";
import { readFileSync, existsSync } from "node:fs";

/** Hard floor between posts. "Here and there", not a feed. */
const MIN_GAP_MS = Number(process.env.MERD_POST_MIN_GAP_HOURS ?? 8) * 3600_000;
/** How often to consider posting. Most cycles decide not to. */
const CHECK_MS = Number(process.env.MERD_POST_CHECK_MINUTES ?? 45) * 60_000;
/** How far back to look when deciding whether he is repeating himself. */
const RECENT = 12;

export interface CadenceResult {
  posted: boolean;
  text?: string;
  reason?: string;
}

/** The ledger is append-only JSONL; there is no reader in ledger.ts, so read it. */
function ledgerRows(): Array<{ at?: number; text?: string; mode?: string }> {
  try {
    const p = dataPath("x-posts.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

function recentTexts(): string[] {
  return ledgerRows()
    .slice(-RECENT)
    .map((r) => String(r.text ?? ""))
    .filter(Boolean);
}

function lastPostAt(): number {
  const rows = ledgerRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    // Draft entries count toward the gap too, so switching X_LIVE on does not
    // suddenly release a backlog of everything drafted this week. Blocked
    // candidates do not — being stopped is not the same as having spoken.
    if (rows[i].at && rows[i].mode !== "blocked") return rows[i].at as number;
  }
  return 0;
}

/**
 * One decision. Returns what happened rather than throwing, because this runs
 * unattended and a bad cycle must never take the operator down.
 */
export async function considerPost(signals: MerdSignals, now = Date.now()): Promise<CadenceResult> {
  if (!xConfigured()) return { posted: false, reason: "X credentials not configured" };

  const since = now - lastPostAt();
  if (since < MIN_GAP_MS) {
    return { posted: false, reason: `only ${Math.round(since / 3600_000)}h since the last one` };
  }

  const candidates = composeMerdTweets(signals);
  if (candidates.length === 0) return { posted: false, reason: "nothing concrete to say" };

  const recent = recentTexts();
  for (const text of candidates) {
    if (isJunk(text)) continue;

    // The boundary that matters. A blocked candidate is recorded rather than
    // silently dropped: if the model keeps reaching for the launch, that is
    // something to see, not something to hide.
    const forbidden = forbiddenReason(text);
    if (forbidden) {
      appendLedger("x-posts.jsonl", { at: now, mode: "blocked", posted: false, reason: forbidden, text });
      continue;
    }

    const similar = tooSimilar(text, recent);
    if (similar) continue;
    const stat = repeatedStat(text, recent);
    if (stat) continue;

    const result = await postTweet(text);
    return { posted: result.posted, text, reason: result.reason };
  }

  return { posted: false, reason: "every candidate was blocked, repetitive or junk" };
}

/**
 * Start the loop. Safe to call unconditionally — it no-ops without credentials,
 * and stays in draft mode unless X_LIVE is explicitly "true".
 */
export function startMerdCadence(getSignals: () => MerdSignals | Promise<MerdSignals>): void {
  if (!xConfigured()) {
    console.log("[merd-cadence] X not configured, not starting");
    return;
  }
  console.log(
    `[merd-cadence] ${xLive() ? "LIVE — posts will publish" : "draft mode — candidates go to x-posts.jsonl only"}` +
      `, checking every ${Math.round(CHECK_MS / 60000)}m, minimum ${Math.round(MIN_GAP_MS / 3600_000)}h between posts`,
  );

  const tick = async () => {
    try {
      const r = await considerPost(await getSignals());
      if (r.posted) console.log(`[merd-cadence] posted: ${r.text}`);
      else if (r.text) console.log(`[merd-cadence] drafted: ${r.text}`);
    } catch (err) {
      console.error("[merd-cadence] cycle failed (continuing):", err instanceof Error ? err.message : err);
    }
  };

  setTimeout(tick, 60_000).unref?.(); // one cycle shortly after boot, then settle
  setInterval(tick, CHECK_MS).unref?.();
}
