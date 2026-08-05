import { test } from "node:test";
import assert from "node:assert/strict";
import { volumeMode } from "../src/memeGuard.js";

test("volume mode needs BOTH hot pulse and calm drift", () => {
  assert.equal(volumeMode(80, 2), true);
  assert.equal(volumeMode(80, -3.5), true);
  assert.equal(volumeMode(30, 2), false); // quiet pool: no reason to tighten
  assert.equal(volumeMode(80, 6), false); // trending: chase clock owns it
  assert.equal(volumeMode(80, null), false); // unknown drift fails closed
});

test("knife territory can never read as volume mode", () => {
  assert.equal(volumeMode(200, 10.5), false);
  assert.equal(volumeMode(200, -12), false);
});
