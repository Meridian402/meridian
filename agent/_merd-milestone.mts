// Operator-called milestone announcement: net profit crossed the entire
// starting stake. The number is read from chain AT POST TIME, not pasted from
// a screenshot, and the post refuses to go out if the claim has stopped being
// true in the minutes since someone decided to make it. A milestone post that
// cites a stale number is exactly the kind of tweet this account does not do.
//
// DRY_RUN=1 prints and posts nothing.
import { postTweet } from "./src/social/xClient.js";
import { forbiddenReason } from "./src/social/postGuards.js";

const BS = "https://robinhoodchain.blockscout.com/api/v2";
const TREASURY = "0x475C1fe4d1e7A703eaca6141978b04010e410Bf4";
const EXECUTION = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe";
const CAPITAL_IN_USD = 997; // same constant the site's widget uses

const get = async (u: string) =>
  (await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) })).json();

let bankedEth = 0;
let ethUsd = 0;
for (const w of [TREASURY, EXECUTION]) {
  const a = (await get(`${BS}/addresses/${w}`)) as { coin_balance?: string; exchange_rate?: string };
  if (!ethUsd) ethUsd = Number(a.exchange_rate ?? 0);
  bankedEth += Number(a.coin_balance ?? 0) / 1e18;
  try {
    const tb = (await get(`${BS}/addresses/${w}/token-balances`)) as { token?: { symbol?: string }; value?: string }[];
    for (const b of tb) if (b.token?.symbol === "WETH") bankedEth += Number(b.value ?? 0) / 1e18;
  } catch {
    /* token balances are additive only; a miss just understates us */
  }
}
const book = (await get("https://meridian402-api-production.up.railway.app/api/book-history")) as {
  points: { working?: number }[];
};
const workingUsd = book.points.at(-1)?.working ?? 0;

const banked = bankedEth * ethUsd;
const net = banked + workingUsd - CAPITAL_IN_USD;
console.log(`banked $${banked.toFixed(2)} + working $${workingUsd.toFixed(2)} - $${CAPITAL_IN_USD} in = net +$${net.toFixed(2)}`);

if (!(ethUsd > 0) || !(workingUsd >= 0) || net <= CAPITAL_IN_USD) {
  console.error(`refusing to post: the milestone does not hold at this moment (net $${net.toFixed(2)} vs stake $${CAPITAL_IN_USD})`);
  process.exit(1);
}

const text =
  `as i write this the ledger reads +$${Math.floor(net).toLocaleString("en-US")} net across every wallet and position, against $997 ever put in. ` +
  `the operation has now earned more than everything it started with. ` +
  `all of it is readable straight from the chain, and the site does the math in your browser: meridian402.xyz`;

const bad = forbiddenReason(text);
if (bad) {
  console.error(`guard refused: ${bad}`);
  process.exit(1);
}
if (process.env.DRY_RUN === "1") {
  console.log(`DRY RUN (${text.length} chars):\n${text}`);
  process.exit(0);
}
const res = await postTweet(text);
console.log(JSON.stringify(res));
