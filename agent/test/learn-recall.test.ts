import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRecall, queryTags } from "../src/learn/recall.js";

test("pool match outweighs kind and time together", () => {
  const poolOnly = scoreRecall(["pool:cashcat", "kind:collect", "day"], ["pool:cashcat"]);
  const kindAndTime = scoreRecall(["pool:stonkbroker", "kind:stop-loss", "night"], ["kind:stop-loss", "night"]);
  assert.equal(poolOnly, 3);
  assert.equal(kindAndTime, 3);
  const full = scoreRecall(["pool:cashcat", "kind:stop-loss", "night"], ["pool:cashcat", "kind:stop-loss", "night"]);
  assert.equal(full, 6);
});

test("no overlap scores zero, so unrelated memories never surface", () => {
  assert.equal(scoreRecall(["pool:bourse", "kind:expand", "day"], ["pool:cashcat", "kind:stop-loss", "night"]), 0);
});

test("queryTags buckets thin hours as night and lowercases the pool", () => {
  assert.deepEqual(queryTags({ pool: "CASHCAT", kind: "stop-loss", hour: 3 }), ["pool:cashcat", "kind:stop-loss", "night"]);
  assert.deepEqual(queryTags({ pool: "cashcat", hour: 14 }), ["pool:cashcat", "day"]);
  assert.deepEqual(queryTags({}), []);
});
