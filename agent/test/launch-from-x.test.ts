import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MERIDIAN_DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-lx-"));
process.env.MERIDIAN_LIVE_PRICES = "0";
delete process.env.MERD_LAUNCH_WALLET_KEY; // dormant

const { parseLaunchRequest, launchDoneReply, launchHelpReply, handleLaunchMention } = await import("../src/launch/launchFromX.js");
const { MERD_ADDRESS } = await import("../src/merd/merd.js");

const WALLET = "0x1111111111111111111111111111111111111111";

// ── parsing ───────────────────────────────────────────────────────────────

test("a full request parses into ticker, name and wallet", () => {
  const r = parseLaunchRequest(`@Meridian402 launch $DOGE My Cool Token ${WALLET}`);
  assert.deepEqual(r, { ok: true, symbol: "DOGE", name: "My Cool Token", feeWallet: WALLET });
});

test("a bare launch with no name defaults the name to the ticker", () => {
  const r = parseLaunchRequest(`@Meridian402 launch $PEPE ${WALLET}`);
  assert.deepEqual(r, { ok: true, symbol: "PEPE", name: "PEPE", feeWallet: WALLET });
});

test("no launch verb is not a launch request", () => {
  assert.deepEqual(parseLaunchRequest(`hey @Meridian402 what do you think of $DOGE ${WALLET}?`), { ok: false, reason: "not_a_launch" });
});

test("a launch with no wallet is caught so fees never go nowhere", () => {
  assert.deepEqual(parseLaunchRequest("@Meridian402 launch $DOGE Doge Coin"), { ok: false, reason: "missing_wallet" });
});

test("a launch with no ticker asks for one", () => {
  assert.deepEqual(parseLaunchRequest(`@Meridian402 launch my token ${WALLET}`), { ok: false, reason: "missing_symbol" });
});

test("a passing mention of the word launch does not trigger a spend", () => {
  // The single most important parse case: chatter must not deploy anything.
  assert.equal(parseLaunchRequest("congrats on the launch! big day").ok, false);
});

// ── the reply is templated and MERD-safe ────────────────────────────────────

test("the done reply includes the user's token but REFUSES the MERD address", () => {
  const ok = launchDoneReply("DOGE", WALLET);
  assert.match(ok, /\$DOGE/);
  assert.match(ok, new RegExp(WALLET));
  assert.throws(() => launchDoneReply("MERD", MERD_ADDRESS), /refusing to post the MERD address/);
});

test("the help reply tells them exactly what to add", () => {
  assert.match(launchHelpReply("missing_wallet"), /wallet/i);
  assert.match(launchHelpReply("missing_symbol"), /ticker/i);
});

// ── end to end while dormant ────────────────────────────────────────────────

test("a real request while dormant replies gracefully, never deploys", async () => {
  const out = await handleLaunchMention({ text: `launch $DOGE Doge ${WALLET}`, authorId: "x123" });
  assert.equal(out.action, "reply");
  assert.equal(out.launched?.ok, false);
  assert.equal(out.launched?.code, "disabled");
  assert.match(out.text, /not open yet/i);
});

test("a non-launch mention is skipped so normal engagement still handles it", async () => {
  const out = await handleLaunchMention({ text: "gm @Meridian402, love the desk", authorId: "x123" });
  assert.deepEqual(out, { action: "skip" });
});
