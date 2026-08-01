// The X-facing edge of custodial launch: read a launch request out of a public
// mention, run it through the deployer, and turn the outcome into a reply.
//
// The deploy and every guardrail (caps, dormancy, fee attribution) live in
// custodialLaunch.ts. This file only parses and replies. Two things it is
// careful about:
//
//   1. A launch reply names a token ADDRESS, which the freeform post guard
//      (forbiddenReason) blocks because that guard exists to stop Merd ever
//      posting a contract address near the MERD embargo. So launch replies do
//      NOT go through that guard. Instead they are TEMPLATED, so nothing the
//      requester writes can steer them, and launchDoneReply refuses outright to
//      format the MERD address. A user's own token is theirs to make public;
//      MERD is not.
//
//   2. Parsing is strict. A launch only fires on an explicit "launch $TICKER"
//      WITH a wallet, so a passing mention of the word cannot spend money, and a
//      request missing its wallet gets told what to add rather than silently
//      deploying a token whose fees would go nowhere.
import { MERD_ADDRESS } from "../merd/merd.js";
import { executeCustodialLaunch, type LaunchResult } from "./custodialLaunch.js";

const TRIGGER_RE = /\blaunch\b/i;
// $TICKER: a letter then 1-9 more letters/digits. Bounded so a stray "$5" or a
// price like "$SPY500" past ten chars is not read as a ticker.
const SYMBOL_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/;
const WALLET_RE = /\b0x[0-9a-fA-F]{40}\b/;
const EXPLORER = "https://robinhoodchain.blockscout.com/token";

export type ParsedLaunch =
  | { ok: true; symbol: string; name: string; feeWallet: string }
  | { ok: false; reason: "not_a_launch" | "missing_symbol" | "missing_wallet" };

/**
 * Pull a launch request out of a mention. Returns ok only when there is an
 * explicit launch verb, a ticker, AND a wallet, because all three are needed to
 * deploy a token whose fees actually reach the person who asked.
 */
export function parseLaunchRequest(text: string): ParsedLaunch {
  if (!TRIGGER_RE.test(text)) return { ok: false, reason: "not_a_launch" };
  const sym = SYMBOL_RE.exec(text);
  if (!sym) return { ok: false, reason: "missing_symbol" };
  const wallet = WALLET_RE.exec(text);
  if (!wallet) return { ok: false, reason: "missing_wallet" };

  const symbol = sym[1].toUpperCase();
  // The name is whatever prose is left once the machinery is stripped: the
  // @handles, the ticker, the wallet, any links, and the launch verb. Falls
  // back to the symbol so a bare "launch $DOGE 0x…" still gets a name.
  const name =
    text
      .replace(/@\w+/g, " ")
      .replace(WALLET_RE, " ")
      .replace(SYMBOL_RE, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\blaunch\b/i, " ")
      .replace(/\s+/g, " ")
      .trim() || symbol;

  return { ok: true, symbol, name, feeWallet: wallet[0] };
}

/** What to say when a mention is a launch attempt we cannot act on yet. */
export function launchHelpReply(reason: "missing_symbol" | "missing_wallet"): string {
  return reason === "missing_symbol"
    ? "to launch, tell me the ticker and your wallet, like: launch $TICKER Your Token Name 0xYourWallet"
    : "almost, i just need your wallet so the token's fees go to you. reply: launch $TICKER Name 0xYourWallet";
}

/**
 * The reply for a landed launch. Templated so it cannot be steered by the
 * request text, and it will not format the MERD address under any
 * circumstances: a user's token is theirs to publish, MERD is not.
 */
export function launchDoneReply(symbol: string, token: string): string {
  if (token.toLowerCase() === MERD_ADDRESS.toLowerCase()) {
    throw new Error("refusing to post the MERD address");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("invalid token address");
  const t = `$${symbol.toUpperCase()}`;
  return `launched ${t} for you. it is live on PONS and the trading fees are yours. ${EXPLORER}/${token}`;
}

export interface LaunchMention {
  text: string;
  /** Stable X author id: keys the per-requester cap so one account cannot spam
   *  through many wallets. Falls back to the fee wallet inside the deployer. */
  authorId?: string;
}

export type MentionOutcome =
  | { action: "skip" } // not a launch request at all
  | { action: "reply"; text: string; launched?: LaunchResult };

/**
 * Handle one mention end to end: parse, and if it is a real request, deploy and
 * reply. A non-launch mention is skipped so the normal engagement path can
 * still handle it. An incomplete request gets a help reply; a completed one
 * gets a confirmation; a failed one gets the deployer's plain reason.
 */
export async function handleLaunchMention(m: LaunchMention): Promise<MentionOutcome> {
  const parsed = parseLaunchRequest(m.text);
  if (!parsed.ok) {
    if (parsed.reason === "not_a_launch") return { action: "skip" };
    return { action: "reply", text: launchHelpReply(parsed.reason) };
  }

  const launched = await executeCustodialLaunch({
    symbol: parsed.symbol,
    name: parsed.name,
    feeWallet: parsed.feeWallet,
    requester: m.authorId,
  });

  if (launched.ok) {
    return { action: "reply", text: launchDoneReply(launched.symbol, launched.token), launched };
  }
  // Turn the machine reason into something a person can act on.
  const text =
    launched.code === "disabled"
      ? "launches from X are not open yet. hang tight."
      : launched.code === "capped"
        ? launched.error
        : launched.code === "invalid"
          ? `i could not launch that: ${launched.error}`
          : "something went wrong launching that, and nothing was spent. try again in a bit.";
  return { action: "reply", text, launched };
}
