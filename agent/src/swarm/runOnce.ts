// Run exactly one exchange and print it. The operator's way to see the feature
// work (or see exactly why it did not) without turning the scheduler on.
// Usage: npm run swarm-once
import { market } from "../state.js";
import { runExchange } from "./exchange.js";
import { rosterHealth } from "./roster.js";

// The LIVE roster, not the eligible one: printing agents that are not actually
// on the gateway is how you spend an afternoon debugging a conversation that
// never had two speakers to begin with.
const health = await rosterHealth();
console.log(`[swarm-once] gateway reachable: ${health.gatewayReachable}`);
console.log(`[swarm-once] ${health.live.length} live participant(s): ${health.live.map((p) => `${p.displayName} (${p.kind})`).join(", ") || "none"}`);
if (health.missing.length) {
  console.log(`[swarm-once] ${health.missing.length} eligible but not provisioned on the gateway: ${health.missing.map((m) => m.id).join(", ")}`);
}

// The market feed refreshes asynchronously at import, so a CLI run reaches
// buildTopic before any live state exists and gets told, correctly, that there
// is nothing real to talk about. The server never hits this (its first exchange
// is a full interval after boot), so the wait belongs here rather than in the
// topic builder, which should keep refusing to invent a premise.
for (let i = 0; i < 30 && !market.dataSource().live; i++) {
  await new Promise((r) => setTimeout(r, 500));
}
const feed = market.dataSource();
console.log(`[swarm-once] live market feed: ${feed.live ? `${feed.liveCount}/${feed.assetCount} quoted` : "not ready"}`);

const result = await runExchange();
if (!result.ok && !result.turns.length) {
  console.log(`[swarm-once] no exchange: ${result.reason}`);
  process.exit(1);
}

console.log(`\n[swarm-once] ${result.exchangeId}${result.ok ? "" : ` (stopped early: ${result.reason})`}`);
console.log(`\nTOPIC: ${result.topic}\n`);
for (const t of result.turns) console.log(`${t.speakerName}:\n${t.text}\n`);
for (const t of result.takeaways) console.log(`TAKEAWAY ${t.speakerName}: ${t.text}`);
process.exit(0);
