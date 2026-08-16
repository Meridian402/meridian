import { test } from "node:test";
import assert from "node:assert/strict";

// Production env, deliberately: the first dry-run table quietly used the code
// default ($75) instead of the deployed limit ($120) and reported thresholds
// production would never hit. Dry runs must wear the same clothes as prod.
process.env.MERIDIAN_DAILY_LOSS_LIMIT_USD = "120";
process.env.MERIDIAN_DAILY_LOSS_PCT = "15";
const { scaledDailyLimit, breakerStage } = await import("../src/memeGuard.js");

test("small book: the $120 floor holds exactly as advertised", () => {
  assert.equal(scaledDailyLimit(0), 120);
  assert.equal(scaledDailyLimit(250), 120);
  assert.equal(scaledDailyLimit(800), 120, "15% of 800 is 120; the floor and the scale meet here");
});

test("at size the limit is proportional: $1,200 working -> $180 limit", () => {
  assert.equal(scaledDailyLimit(1200), 180);
});

test("the envelope at full deployment: stage 1 at a 15% day, flatten at 30%", () => {
  const limit = scaledDailyLimit(1200);
  assert.equal(breakerStage(1200 * 0.10, limit), 0, "a 10% day now rides");
  assert.equal(breakerStage(1200 * 0.15, limit), 1, "a 15% day halts quoting");
  assert.equal(breakerStage(1200 * 0.25, limit), 1, "a 25% day is still stage 1");
  assert.equal(breakerStage(1200 * 0.30, limit), 2, "a 30% day flattens");
});

test("the envelope when small is unchanged from the advertised floor", () => {
  const limit = scaledDailyLimit(250);
  assert.equal(breakerStage(119, limit), 0);
  assert.equal(breakerStage(120, limit), 1);
  assert.equal(breakerStage(240, limit), 2);
});
