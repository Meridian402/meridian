// One revenue cycle, prepared as UNSIGNED transactions: the marketing payout
// and the buyback-and-burn, same day, same script, so both sides of the
// promise land together and can be checked against one date.
//
// This file NEVER signs. It prints the exact calldata for the treasury to
// execute, because the treasury's standing policy is that a human runs
// anything that moves its money.
import { encodeFunctionData, parseAbi, formatEther, type Address } from "viem";
import { getPublicClient } from "./src/venues/signer.js";

const TREASURY: Address = "0x475C1fe4d1e7A703eaca6141978b04010e410Bf4";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const MERD: Address = "0x12f8Cca1875B6CdfaF00f7Efde52A40C275Ab8d8";
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
// Verified 2026-08-08: this router's factory() is the MERD pool's factory.
const ROUTER: Address = "0xD089eBB5609Dd1FE604E1f8ecd9B88Bd5d128713";
const POOL_FEE = 10000; // 1%, read from the pool
const MARKETING = (process.env.CYCLE_MARKETING_WALLET ?? "") as Address;
const SHARE_BPS = 2500; // 25% each, per the allocation policy

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
const weth = parseAbi(["function withdraw(uint256)"]);
const router = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);

const client = getPublicClient();
const wethBal = await client.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [TREASURY] });
const slice = (wethBal * BigInt(SHARE_BPS)) / 10000n;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

const steps = [
  {
    what: `unwrap ${formatEther(slice)} WETH to native (the marketing wallet holds no gas, so it is paid in ETH)`,
    to: WETH,
    data: encodeFunctionData({ abi: weth, functionName: "withdraw", args: [slice] }),
    value: "0",
  },
  {
    what: `pay marketing ${formatEther(slice)} ETH -> ${MARKETING}`,
    to: MARKETING,
    data: "0x",
    value: slice.toString(),
  },
  {
    what: `approve the router for ${formatEther(slice)} WETH`,
    to: WETH,
    data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, slice] }),
    value: "0",
  },
  {
    what: `buy MERD with ${formatEther(slice)} WETH (1% pool, recipient = treasury)`,
    to: ROUTER,
    data: encodeFunctionData({
      abi: router,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WETH,
          tokenOut: MERD,
          fee: POOL_FEE,
          recipient: TREASURY,
          deadline,
          amountIn: slice,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    value: "0",
  },
  {
    what: "burn: transfer the MERD just bought to the dead address (fill in the exact amount received from step 4)",
    to: MERD,
    data: "(encode transfer(0x…dEaD, <amount received>) after the swap lands)",
    value: "0",
  },
];

console.log(`treasury WETH: ${formatEther(wethBal)}  ·  25% slice: ${formatEther(slice)} each\n`);
for (const [i, s] of steps.entries()) {
  console.log(`STEP ${i + 1}: ${s.what}`);
  console.log(`  to:    ${s.to}`);
  console.log(`  value: ${s.value}`);
  console.log(`  data:  ${typeof s.data === "string" && s.data.startsWith("0x") ? s.data.slice(0, 90) + (s.data.length > 90 ? "…" : "") : s.data}\n`);
}
