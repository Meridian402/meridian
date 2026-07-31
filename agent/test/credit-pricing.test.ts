import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKS } from "../src/credits.js";

// Measured against the provider's own billing, not estimated: a message costs
// about $0.0104 inside a warm conversation and about $0.0242 on the first
// message of a sitting, because the cached prefix has to be written again.
//
// Credits were sold at $0.010, so every message was sold below cost and the
// loss was worst on the lightest users. This file exists so that cannot come
// back quietly: the rule is priced-above-cost, and the rule is what is pinned
// here rather than the particular numbers.
const WARM = 0.0104;
const COLD = 0.0242;

const rate = (p: (typeof PACKS)[number]) => p.usd / p.credits;

test("every pack clears the cost of a warm conversation", () => {
  for (const p of PACKS) {
    assert.ok(rate(p) > WARM, `${p.id} sells at $${rate(p).toFixed(4)}, under the $${WARM} warm cost`);
  }
});

test("the entry pack clears the WORST case, not the average", () => {
  // The cheapest pack is what a newcomer buys, and a newcomer is exactly the
  // person who sends one message and closes the tab. Pricing the entry tier off
  // the average would sell that person at a loss every time.
  const starter = PACKS.reduce((a, b) => (a.usd <= b.usd ? a : b));
  assert.ok(
    rate(starter) >= COLD,
    `entry pack sells at $${rate(starter).toFixed(4)}, under the $${COLD} cold-start cost`,
  );
});

test("bigger packs are cheaper per credit, which the cost curve earns", () => {
  // Not generosity: a longer sitting is cheaper per message because the cached
  // prefix is already warm, so the buyers getting the discount are the ones who
  // cost less to serve.
  const byPrice = [...PACKS].sort((a, b) => a.usd - b.usd);
  for (let i = 1; i < byPrice.length; i++) {
    assert.ok(
      rate(byPrice[i]) < rate(byPrice[i - 1]),
      `${byPrice[i].id} is not better value than ${byPrice[i - 1].id}`,
    );
  }
});

test("no pack is discounted past what a real conversation costs", () => {
  // The volume discount has a floor. Below the warm cost, a heavy user becomes
  // a loss no matter how engaged they are.
  for (const p of PACKS) {
    assert.ok(rate(p) > WARM, `${p.id} discounted to $${rate(p).toFixed(4)}, below warm cost`);
  }
});

test("packs are whole numbers a person can reason about", () => {
  for (const p of PACKS) {
    assert.equal(p.credits, Math.round(p.credits));
    assert.ok(p.credits % 50 === 0, `${p.id} has ${p.credits} credits, which reads like an accident`);
    assert.ok(p.usd > 0 && p.credits > 0);
  }
  assert.equal(new Set(PACKS.map((p) => p.id)).size, PACKS.length, "duplicate pack id");
});

test("the advertised bonus matches the arithmetic", () => {
  // A stated bonus that does not survive division is a false claim on a pricing
  // page, which is the worst place to have one.
  const base = PACKS.reduce((a, b) => (a.usd <= b.usd ? a : b));
  const perDollar = base.credits / base.usd;
  for (const p of PACKS) {
    if (!("bonusPct" in p) || !p.bonusPct) continue;
    const actual = ((p.credits / p.usd / perDollar) - 1) * 100;
    assert.ok(
      Math.abs(actual - p.bonusPct) <= 1.5,
      `${p.id} advertises +${p.bonusPct}% but actually gives +${actual.toFixed(1)}%`,
    );
  }
});
