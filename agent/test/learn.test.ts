import { test } from "node:test";
import assert from "node:assert/strict";
import { trainModel, predict, accuracy } from "../src/learn/model.js";
import { buildDataset, evaluate, features, FEATURE_DIM } from "../src/learn/harness.js";

test("the model learns a separable pattern", () => {
  // y = 1 when feature 0 is high. A learner must fit this near-perfectly.
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 60; i++) {
    const hi = i % 2 === 0;
    X.push([hi ? 1 + (i % 5) * 0.1 : -1 - (i % 5) * 0.1, (i % 7) * 0.01]);
    y.push(hi ? 1 : 0);
  }
  const m = trainModel(X, y);
  assert.ok(accuracy(m, X, y) > 0.95, "separable data is learned");
  assert.ok(predict(m, [3, 0]) > 0.5 && predict(m, [-3, 0]) < 0.5, "predictions follow the pattern");
});

test("feature vector has the declared dimension", () => {
  assert.equal(features("CASHCAT", Date.now(), 3.2).length, FEATURE_DIM);
  assert.equal(features("UNKNOWN", Date.now(), null).length, FEATURE_DIM);
});

test("dataset labels collects positive, unfilled stops negative", () => {
  const lines = [
    JSON.stringify({ kind: "collect", pool: "CASHCAT", ts: 1e12, feesUsdAtRead: 10 }),
    JSON.stringify({ kind: "stop-loss", pool: "CASHCAT", ts: 1e12 + 1, reason: "maker exit unfilled 30min" }),
    JSON.stringify({ kind: "stop-loss", pool: "CASHCAT", ts: 1e12 + 2, reason: "drawdown 6.0%" }), // ambiguous, skipped
    JSON.stringify({ kind: "rotate", pool: "STONKBROKER", ts: 1e12 + 3, tokenMoved: "100" }),
  ];
  const ds = buildDataset(lines);
  assert.equal(ds.length, 3, "the drawdown stop is skipped for this label");
  assert.deepEqual(ds.map((e) => e.y), [1, 0, 1]);
});

test("evaluate is honest about cold-start", () => {
  const s = evaluate([]);
  assert.equal(s.mode, "shadow");
  assert.equal(s.promoted, false);
  assert.match(s.note, /cold start/);
});
