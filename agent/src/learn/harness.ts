// The learning harness, SHADOW MODE. It turns the desk's own journal into a
// labeled dataset, trains the model, evaluates it OUT OF SAMPLE against a
// dumb baseline, and reports whether it is winning yet. It changes no trade
// and moves no knob. When (and only when) the model beats the baseline
// out-of-sample by a real margin over enough samples does it become a
// candidate to drive decisions, and that promotion is a separate, deliberate
// step. This file is the continuous-learning machine; today it watches.
//
// Honest label note: the current journal does not cleanly say "this exact
// band filled." So v1 uses a PROXY: entries where the desk earned/cycled
// (collect, or a rotation that moved real inventory) are positive; unfilled
// timeout stop-losses are negative. It is noisy and small, and the status
// endpoint says so. The signal sharpens the moment the flow recorder's
// per-swap data feeds this instead (the real fill-probability label).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "../dataDir.js";
import { trainModel, predict, accuracy, type LearnedModel } from "./model.js";

const JOURNAL = dataPath("meme-rotations.jsonl");
const MODEL_PATH = dataPath("learn-model.json");

export interface Example {
  x: number[];
  y: number;
  ts: number;
}

/** Feature vector for one situation. Kept legible so a human can audit what
 *  the model keys on: pool identity, time of day (cyclic), drift magnitude. */
const POOLS = ["CASHCAT", "STONKBROKER", "BOURSE", "UNIFROG"] as const;
export function features(pool: string, ts: number, driftPctPerHr: number | null): number[] {
  const hour = new Date(ts).getUTCHours();
  const poolOneHot = POOLS.map((p) => (p === pool ? 1 : 0));
  return [
    ...poolOneHot,
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    Math.min(Math.abs(driftPctPerHr ?? 0), 50) / 50, // |drift| normalized 0..1
  ];
}
export const FEATURE_DIM = POOLS.length + 3;

/** Build labeled examples from the journal. Positive = the desk earned/cycled;
 *  negative = a maker exit timed out unfilled. */
export function buildDataset(lines: string[]): Example[] {
  const out: Example[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = String(e.kind ?? "rotate");
    const pool = String(e.pool ?? e.venue ?? "");
    const ts = Number(e.ts ?? 0);
    if (!pool || !ts) continue;
    const drift = e.driftPctPerHr != null ? Number(e.driftPctPerHr) : null;

    if (kind === "collect") out.push({ x: features(pool, ts, drift), y: 1, ts });
    else if (kind === "stop-loss" && /unfilled/i.test(String(e.reason ?? ""))) out.push({ x: features(pool, ts, drift), y: 0, ts });
    else if (kind === "rotate" && Number(e.tokenMoved ?? 0) > 0) out.push({ x: features(pool, ts, drift), y: 1, ts });
    // pure ETH re-quotes and drawdown stops are ambiguous for THIS label; skipped.
  }
  return out;
}

export interface LearnStatus {
  mode: "shadow";
  samples: number;
  positives: number;
  trainN: number;
  testN: number;
  modelAccuracy: number | null;
  baselineAccuracy: number | null;
  beatsBaseline: boolean;
  promoted: false;
  note: string;
  updatedAt: number;
}

/** Train on the older split, evaluate on the newer split, compare to the
 *  majority-class baseline. Time-ordered so the test is genuinely
 *  out-of-sample (predicting later situations from earlier ones). */
export function evaluate(examples: Example[]): LearnStatus {
  const base: LearnStatus = {
    mode: "shadow",
    samples: examples.length,
    positives: examples.filter((e) => e.y === 1).length,
    trainN: 0,
    testN: 0,
    modelAccuracy: null,
    baselineAccuracy: null,
    beatsBaseline: false,
    promoted: false,
    note: "",
    updatedAt: Date.now(),
  };
  if (examples.length < 20) {
    return { ...base, note: `cold start: ${examples.length} proxy-labeled samples, need ~20+ before a fit means anything. Learning as data accrues.` };
  }
  const sorted = [...examples].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * 0.7);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  // Degenerate splits (one class) make accuracy meaningless.
  const trainClasses = new Set(train.map((e) => e.y));
  if (trainClasses.size < 2 || test.length === 0) {
    return { ...base, trainN: train.length, testN: test.length, note: "not enough class variety yet for an honest fit; still watching." };
  }
  const model = trainModel(train.map((e) => e.x), train.map((e) => e.y));
  writeFileSync(MODEL_PATH, JSON.stringify(model));
  const modelAcc = accuracy(model, test.map((e) => e.x), test.map((e) => e.y));
  // Baseline: always predict the training-majority class.
  const posRate = train.filter((e) => e.y === 1).length / train.length;
  const majority = posRate >= 0.5 ? 1 : 0;
  const baseAcc = test.filter((e) => e.y === majority).length / test.length;
  const beats = modelAcc > baseAcc + 0.05; // a real margin, not noise
  return {
    ...base,
    trainN: train.length,
    testN: test.length,
    modelAccuracy: Math.round(modelAcc * 1000) / 1000,
    baselineAccuracy: Math.round(baseAcc * 1000) / 1000,
    beatsBaseline: beats,
    note: beats
      ? `model beats the baseline out-of-sample (${(modelAcc * 100).toFixed(0)}% vs ${(baseAcc * 100).toFixed(0)}%). Still shadow; promotion is a deliberate step, not automatic.`
      : `model not beating the baseline yet (${(modelAcc * 100).toFixed(0)}% vs ${(baseAcc * 100).toFixed(0)}%). Correct outcome for this little data; it improves as the journal grows.`,
  };
}

export function runLearningPass(): LearnStatus {
  const lines = existsSync(JOURNAL) ? readFileSync(JOURNAL, "utf8").split("\n") : [];
  return evaluate(buildDataset(lines));
}

/** The current shadow model, if one has been fit. For inspection only; nothing
 *  in the trading path reads this until promotion is built. */
export function loadShadowModel(): LearnedModel | null {
  try {
    return existsSync(MODEL_PATH) ? (JSON.parse(readFileSync(MODEL_PATH, "utf8")) as LearnedModel) : null;
  } catch {
    return null;
  }
}
export { predict };
