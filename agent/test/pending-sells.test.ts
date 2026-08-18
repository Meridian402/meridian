import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRetryDelayMs } from "../src/pendingSells.js";

test("retry backoff doubles from 3 minutes and caps at an hour", () => {
  assert.equal(nextRetryDelayMs(0), 3 * 60e3);
  assert.equal(nextRetryDelayMs(1), 6 * 60e3);
  assert.equal(nextRetryDelayMs(2), 12 * 60e3);
  assert.equal(nextRetryDelayMs(3), 24 * 60e3);
  assert.equal(nextRetryDelayMs(4), 48 * 60e3);
  assert.equal(nextRetryDelayMs(5), 60 * 60e3, "capped: persistent, not a gas faucet");
  assert.equal(nextRetryDelayMs(50), 60 * 60e3, "high attempt counts never overflow past the cap");
  assert.equal(nextRetryDelayMs(-1), 3 * 60e3, "a malformed attempt count degrades to the base delay");
});
