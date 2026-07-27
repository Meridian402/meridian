// The public console: visitors type commands at the site's terminal and get
// answers computed from the same live state the agent trades on. Deliberately
// deterministic (this is a trading desk, not a chatbot) and read-only — every
// command is safe to expose to the open internet, nothing here mutates state
// or leaks secrets. LLM-backed "ask" can layer on later via the gateway.
import { config } from "./config.js";
import { decisionLog } from "./state.js";
import { getAgentAddress, getPublicClient } from "./venues/signer.js";
import { readStockBalances } from "./venues/positionAccounting.js";
import { poolPricesUsd, tradableSymbols } from "./venues/stockPools.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { basisSnapshot } from "./signals/basis.js";
import { lpScoresIfCached } from "./signals/lpScore.js";
import { lpPositionsWithValue } from "./venues/lpPositions.js";
import { marketMakingProof } from "./marketMakingPnl.js";
import { latestScan, scanOpportunities } from "./lpAllocator.js";
import { readRecentExecutions } from "./executionsLog.js";
import { parseAbiItem } from "viem";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const BOOTED_AT = Date.now();

// basis does live Yahoo + RPC reads — cache briefly so the open console
// can't be used to hammer upstreams.
let basisCache: { at: number; lines: string[] } | null = null;

const QUICKSTART_URL = "https://meridian402.xyz/quickstart";
const DEPLOY_URL = "https://meridian402.xyz/#launchpad";
const MCP_ENDPOINT = "https://meridian402-api-production.up.railway.app/mcp";

const HELP = [
  "meridian console — you're talking to a live trading desk. commands:",
  "",
  "  watch the agent (proof it works)",
  "    status     what it's doing right now",
  "    proof      is it profitable? fees minus impermanent loss, vs holding",
  "    pnl        what it holds, marked to market",
  "    trades     every on-chain fill, with tx links",
  "    why        its latest decision + reasoning",
  "",
  "  the data it trades on (and sells)",
  "    basis      24/7 pool price vs the real market, live",
  "    lp         which pools are safe to make markets in",
  "    scan       live ranking of the best LP pool for your capital",
  "    universe   the tradable tickers",
  "",
  "  use meridian yourself",
  "    integrate  connect your agent + buy data (~5 min)",
  "    deploy     launch your own agent",
  "    pricing    what each tool costs",
  "",
  "  new here? type 'start'.",
];

const WELCOME = [
  "welcome — this is Merd, Meridian's own trading agent, live and auditable.",
  "it makes markets in tokenized stocks on Robinhood Chain from a public wallet.",
  "",
  "  · see it work:     try  status  ·  pnl  ·  trades",
  "  · use its tools:   try  integrate  ·  pricing",
  "  · run your own:    try  deploy",
  "",
  "everything here is real and on-chain. type 'help' for the full menu.",
];

const INTEGRATE = [
  "point your agent at Meridian and pay per call — no accounts, no API keys.",
  "",
  `  1. endpoint:  ${MCP_ENDPOINT}`,
  "  2. call a tool with no payment → you get an HTTP 402 quoting the price in USDG",
  "  3. pay the treasury on Robinhood Chain, retry with the tx hash → you get the data",
  "",
  `  full ~60-line client + walkthrough:  ${QUICKSTART_URL}`,
  "  try 'pricing' to see what's on the shelf.",
];

const DEPLOY_HELP = [
  "get your own agent — sign in with your wallet and it's live to talk to in seconds.",
  "no waitlist. your wallet is your account; custody stays yours, always.",
  "it runs the same market-making playbook as the agent you see here.",
  "",
  `  meet your agent:  ${DEPLOY_URL}`,
];

// Map friendly / natural inputs to canonical commands so a newcomer exploring
// the terminal never hits a dead "unknown command" wall.
const ALIASES: Record<string, string> = {
  "": "help", "?": "help", h: "help", commands: "help", menu: "help", options: "help",
  hi: "start", hello: "start", hey: "start", gm: "start", begin: "start", new: "start", "get started": "start", getstarted: "start",
  quickstart: "integrate", docs: "integrate", connect: "integrate", api: "integrate", sdk: "integrate", integrate: "integrate",
  launch: "deploy", agent: "deploy", deploy: "deploy",
  pricing: "tools", price: "tools", prices: "tools", cost: "tools", buy: "tools",
  position: "pnl", portfolio: "pnl", balance: "pnl", holdings: "pnl",
};

function resolveCommand(input: string): string {
  if (input in ALIASES) return ALIASES[input];
  const has = (w: string) => input.includes(w);
  if (has("integrat") || has("connect") || has("how do i use") || has("get data") || has("your api") || has("sdk")) return "integrate";
  if (has("deploy") || has("launch") || has("my own") || has("own agent")) return "deploy";
  if (has("price") || has("cost") || has("how much") || has("pay")) return "tools";
  if (has("start") || has("begin") || has("hello") || has("get started") || has("new here")) return "start";
  if (has("trade") || has("fill")) return "trades";
  if (has("wallet") || has("address")) return "wallet";
  if (has("help") || has("command")) return "help";
  return input;
}

export async function runConsoleCommand(raw: string): Promise<string[]> {
  const input = raw.trim().toLowerCase().slice(0, 80);
  const cmd = resolveCommand(input);
  try {
    switch (cmd) {
      case "help":
        return HELP;

      case "start":
        return WELCOME;

      case "integrate":
        return INTEGRATE;

      case "deploy":
        return DEPLOY_HELP;

      case "status": {
        const uptimeH = (Date.now() - BOOTED_AT) / 3_600_000;
        const latest = decisionLog.recent(1)[0];
        return [
          `live trading: ${config.liveTradingEnabled ? "ARMED" : "paused (observe mode)"}`,
          `think cadence: every ${config.agentThinkIntervalMs / 1000}s · process up ${uptimeH.toFixed(1)}h`,
          `risk caps: $${config.maxTradeUsd}/trade · $${config.maxDailyUsd}/day · one trade per ${config.rotationCooldownHours}h`,
          latest ? `latest decision: ${latest.action.toUpperCase()} — ${latest.reason}` : "no decisions yet this session",
        ];
      }

      case "pnl":
      case "position": {
        const address = getAgentAddress();
        if (!address) return ["no wallet configured"];
        const client = getPublicClient();
        const [balances, pool, ethUsd, ethRaw, usdgRaw, lpPositions] = await Promise.all([
          readStockBalances(address).catch(() => ({}) as Record<string, number>),
          poolPricesUsd().catch(() => ({}) as Record<string, number>),
          fetchEthUsd().catch(() => 0),
          client.getBalance({ address }),
          client.readContract({
            address: USDG,
            abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
            functionName: "balanceOf",
            args: [address],
          }),
          lpPositionsWithValue().catch(() => []),
        ]);
        const lines: string[] = [];
        let total = 0;
        for (const p of lpPositions) {
          total += p.valueUsd;
          lines.push(`LP ${p.symbol}/USDG ±${p.rangePct.toFixed(1)}% = $${p.valueUsd.toFixed(2)} (${p.inRange ? "in range" : "out of range"})`);
        }
        for (const [sym, qty] of Object.entries(balances)) {
          const px = pool[sym];
          if (!qty || qty < 1e-6 || !px) continue;
          const v = qty * px;
          total += v;
          lines.push(`${sym.padEnd(6)} ${qty.toFixed(6)} @ $${px.toFixed(2)} = $${v.toFixed(2)}`);
        }
        const usdg = Number(usdgRaw) / 1e6;
        const eth = Number(ethRaw) / 1e18;
        total += usdg + eth * ethUsd;
        lines.push(`USDG   ${usdg.toFixed(2)}`);
        lines.push(`ETH    ${eth.toFixed(4)} (~$${(eth * ethUsd).toFixed(2)}, gas reserve)`);
        lines.push(`total ≈ $${total.toFixed(2)} — verify: ${EXPLORER}/address/${address}`);
        return lines;
      }

      case "scan": {
        const s = latestScan() ?? (await scanOpportunities());
        const lines = [`LP opportunities right now, ranked by expected net $/day for ~$${Math.round(s.capitalUsd)}:`, ""];
        for (const o of s.opportunities) {
          lines.push(
            `  ${o.pool.padEnd(16)} ${o.viable ? "" : "avoid "}~$${o.expectedNetPerDayUsd.toFixed(2)}/day  (our share ${o.ourSharePct.toFixed(1)}%)`,
          );
        }
        lines.push("");
        lines.push(`> ${s.recommendation}`);
        lines.push("(the agent scans this every ~30min through the day. moving capital is deliberate, never automatic.)");
        return lines;
      }

      case "proof": {
        const p = await marketMakingProof();
        // "nothing to measure" and "we hold positions we can't measure" are very
        // different states — never let the second read as the first.
        const unmeasuredLines = p.unmeasured.map((u) => `  ${u.symbol}/USDG #${u.tokenId} — not measured: ${u.reason}`);
        if (p.positions.length === 0) {
          return p.unmeasured.length
            ? ["holding positions we cannot measure against cost right now:", "", ...unmeasuredLines]
            : ["no open market-making position to measure right now"];
        }
        const lines = [
          "market-making proof — fees minus impermanent loss minus gas, vs simply holding:",
          "",
        ];
        for (const pos of p.positions) {
          lines.push(`  ${pos.symbol}/USDG · ${pos.daysLive.toFixed(1)} days · $${pos.depositUsd.toFixed(2)} deposited`);
          lines.push(`    fees earned:      +$${pos.feesTotalUsd.toFixed(2)}  ($${pos.feesCollectedUsd.toFixed(2)} collected, $${pos.feesUncollectedUsd.toFixed(2)} accruing)`);
          lines.push(`    impermanent loss:  $${pos.impermanentLossUsd.toFixed(2)}`);
          lines.push(`    NET vs holding:    $${pos.netVsHoldUsd.toFixed(2)}  ${pos.profitable ? "→ profitable" : "→ underwater"}`);
        }
        if (unmeasuredLines.length) {
          lines.push("");
          lines.push("excluded from the totals above:");
          lines.push(...unmeasuredLines);
        }
        lines.push("");
        lines.push(`lifetime fees collected: $${p.lifetimeFeesCollectedUsd.toFixed(2)} · every figure reproducible on-chain.`);
        lines.push("(early data — proof is the trend over weeks, not any one reading. watch it live.)");
        return lines;
      }

      case "why": {
        const latest = decisionLog.recent(1)[0];
        if (!latest) return ["no decisions yet this session"];
        return [`[${new Date(latest.timestamp).toISOString()}] ${latest.action.toUpperCase()} — ${latest.reason}`, ...latest.thoughts.map((t) => `  ${t}`)];
      }

      case "trades": {
        const recent = readRecentExecutions(8);
        if (recent.length === 0) return ["no executions recorded yet"];
        return recent.map((e) => {
          const route = e.fromSymbol ? `${e.fromSymbol}->${e.toSymbol}` : (e.toSymbol ?? "");
          const link = e.txHash ? ` ${EXPLORER}/tx/${e.txHash}` : "";
          return `${new Date(e.ts).toISOString().slice(0, 16)} ${e.kind.padEnd(11)} ${route.padEnd(14)} $${e.amountUsd.toFixed(2)} ${e.success ? "ok" : `FAILED: ${e.error?.slice(0, 40)}`}${link}`;
        });
      }

      case "basis": {
        if (basisCache && Date.now() - basisCache.at < 30_000) return basisCache.lines;
        const snap = await basisSnapshot();
        const lines = snap.rows.map(
          (r) => `${r.symbol.padEnd(6)} pool $${r.poolUsd.toFixed(2)} vs market $${r.marketUsd.toFixed(2)} = ${r.basisPct >= 0 ? "+" : ""}${r.basisPct.toFixed(2)}%`,
        );
        lines.push("(agents consume this live as the meridian_basis_feed tool, $0.10/call via x402)");
        basisCache = { at: Date.now(), lines };
        return lines;
      }

      case "lp": {
        const report = lpScoresIfCached();
        if (!report) return ["LP scores warm up on first tool call (a ~1min on-chain scan). Ask again soon, or buy meridian_lp_score ($0.05) to trigger it."];
        const lines = report.pools.map(
          (p) => `${p.pool.padEnd(16)} fees $${p.feesUsd} · markout $${p.markoutUsd} · LP net $${p.lpNetUsd} — ${p.verdict}`,
        );
        lines.push(`(trailing ${report.windowDays}d window, 30min markout; the meridian_lp_score tool, $0.05/call)`);
        return lines;
      }

      case "universe": {
        const live = tradableSymbols();
        return [
          `depth-verified tradable tickers: ${live.join(", ")}`,
          `82 Robinhood tokens exist on-chain; these ${live.length} have pools deep enough to absorb real size (measured and re-qualified every ~30min, not assumed).`,
        ];
      }

      case "tools":
        return [
          "the shelf — pay per call in USDG on Robinhood Chain, no accounts, no keys:",
          ...Object.entries(config.toolPricesUsd).map(([t, p]) => `  ${t.padEnd(26)} $${p.toFixed(2)} / call`),
          "  free: meridian_list_chains, meridian_list_assets, meridian_agent_thoughts, meridian_index_yield",
          "",
          "type 'integrate' for the 3-step connect flow.",
        ];

      case "wallet": {
        const address = getAgentAddress();
        return address
          ? [`agent wallet: ${address}`, `every decision, fill, and payment: ${EXPLORER}/address/${address}`]
          : ["no wallet configured"];
      }

      default:
        return [
          `"${input.slice(0, 40)}" isn't a command yet.`,
          "type 'help' for the menu, or 'start' if you're new here.",
        ];
    }
  } catch (err) {
    return [`command failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}`];
  }
}
