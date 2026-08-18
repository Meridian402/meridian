import { test } from "node:test";
import assert from "node:assert/strict";

// Production env, pinned explicitly (the dry-run lesson: tests wear prod's
// clothes). These are also the code defaults; the pin keeps that true even
// if the defaults drift.
process.env.MERIDIAN_PORTFOLIO_LOSS_LIMIT_USD = "200";
process.env.MERIDIAN_PORTFOLIO_LOSS_PCT = "15";
process.env.MERIDIAN_PORTFOLIO_STAND_DOWN_HOURS = "12";
const { portfolioLimitUsd, portfolioVerdict } = await import("../src/portfolioBreaker.js");
import type { PortfolioState } from "../src/portfolioBreaker.js";

const T0 = 1_787_000_000_000;
const MARK = 2 * 60e3; // the snapshotter's cadence
const fresh = (): PortfolioState => ({ hwm: 0, hwmDay: "", streak: 0, standDownUntil: 0 });

function feed(state: PortfolioState, marks: Array<{ book: number; working: number }>, day = "2026-08-18") {
  let s = state;
  let fired = -1;
  let last: ReturnType<typeof portfolioVerdict> | null = null;
  marks.forEach((m, i) => {
    last = portfolioVerdict(s, m.book, m.working, day, T0 + i * MARK);
    s = last.next;
    if (last.fire && fired < 0) fired = i;
  });
  return { state: s, fired, last: last! };
}

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);

test("the limit: $200 floor when small, 15% of working at size", () => {
  assert.equal(portfolioLimitUsd(0), 200);
  assert.equal(portfolioLimitUsd(1000), 200);
  near(portfolioLimitUsd(1690), 253.5, "the 08-18 board: fully deployed, the day stops at ~$254 instead of $323");
  near(portfolioLimitUsd(2000), 300);
});

test("up-marks ratchet the high-water and never fire", () => {
  const { state, fired } = feed(fresh(), [1800, 1850, 1900, 2187].map((book) => ({ book, working: 1600 })));
  assert.equal(fired, -1);
  assert.equal(state.hwm, 2187);
});

test("the 08-18 replay: three confirming marks past the limit fire the flatten", () => {
  const seed = feed(fresh(), [{ book: 2187, working: 1690 }]).state;
  const { state, fired, last } = feed(seed, [
    { book: 2000, working: 1690 }, // -$187, inside the limit
    { book: 1930, working: 1690 }, // -$257, breach 1
    { book: 1925, working: 1600 }, // breach 2
    { book: 1920, working: 1500 }, // breach 3: fire
  ]);
  assert.equal(fired, 3);
  assert.ok(last.fire);
  assert.equal(state.standDownUntil, T0 + 3 * MARK + 12 * 3600e3, "stood down 12h from the firing mark");
  assert.equal(state.hwm, 1920, "high-water re-arms at the surviving level");
  assert.equal(state.streak, 0);
});

test("one or two bad marks cannot fire: a recovery resets the streak", () => {
  const seed = feed(fresh(), [{ book: 2187, working: 1690 }]).state;
  const { fired } = feed(seed, [
    { book: 1900, working: 1690 }, // breach 1
    { book: 1900, working: 1690 }, // breach 2
    { book: 2000, working: 1690 }, // healed: streak resets
    { book: 1900, working: 1690 }, // breach 1 again
    { book: 1900, working: 1690 }, // breach 2
  ]);
  assert.equal(fired, -1, "a phantom crater that heals within two marks never flattens the book");
});

test("an ordinary bad day under the limit rides forever", () => {
  const seed = feed(fresh(), [{ book: 2000, working: 1200 }]).state;
  const marks = Array.from({ length: 50 }, () => ({ book: 1830, working: 1200 })); // -$170 < $200 floor
  assert.equal(feed(seed, marks).fired, -1);
});

test("the Eastern day roll re-seeds the high-water", () => {
  const seed = feed(fresh(), [{ book: 2187, working: 1690 }], "2026-08-17").state;
  const v = portfolioVerdict(seed, 1900, 1690, "2026-08-18", T0 + MARK);
  assert.equal(v.next.hwm, 1900, "yesterday's high does not count against today");
  assert.equal(v.drawdownUsd, 0);
});

test("during a stand-down nothing re-fires and up-marks still track", () => {
  let s: PortfolioState = { hwm: 1920, hwmDay: "2026-08-18", streak: 0, standDownUntil: T0 + 12 * 3600e3 };
  for (let i = 0; i < 5; i++) {
    const v = portfolioVerdict(s, 1500, 1000, "2026-08-18", T0 + i * MARK);
    assert.equal(v.fire, false);
    s = v.next;
  }
  const up = portfolioVerdict(s, 1960, 1000, "2026-08-18", T0 + 6 * MARK);
  assert.equal(up.next.hwm, 1960);
});

test("after the stand-down expires the breaker is live again from the re-armed level", () => {
  const seed: PortfolioState = { hwm: 1920, hwmDay: "2026-08-18", streak: 0, standDownUntil: T0 - 1 };
  const { fired } = feed(seed, [
    { book: 1700, working: 1200 },
    { book: 1700, working: 1200 },
    { book: 1700, working: 1200 },
  ]);
  assert.equal(fired, 2, "a catastrophe still real when the desk resumes fires again");
});

test("the limit tightens as guards de-risk: shrinking working pulls it to the floor", () => {
  const atSize = portfolioVerdict(fresh(), 2000, 2000, "2026-08-18", T0);
  near(atSize.limitUsd, 300);
  const deRisked = portfolioVerdict(atSize.next, 1750, 400, "2026-08-18", T0 + MARK);
  assert.equal(deRisked.limitUsd, 200, "a mostly-cash book tolerates less further loss, not more");
  assert.equal(deRisked.next.streak, 1, "-$250 breaches the tightened limit");
});
