// Shared output guards for everything Merd says in public: top-level posts,
// mention replies, and outbound replies.
//
// These live in ONE place on purpose. They started duplicated across the post
// and engage jobs and immediately drifted: engage refused to discuss a token
// launch while the autopilot had no such rule at all, so the same agent would
// decline a stranger's question and then volunteer the topic himself an hour
// later. Safety rules that are copy-pasted stop matching, and the gap is never
// noticed until it is public.

/** Strip dashes used as punctuation. House rule bans em AND en dashes. */
export function stripDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/ -- /g, ", ");
}

/**
 * Drop sentences that repeat one already said.
 *
 * The gateway intermittently returns the whole answer twice, the second copy
 * lowercased and concatenated with no space ("...professional market.automating
 * the liquidity-lock checks..."). It is not every response, which is worse than
 * always: a malformed reply would reach the timeline every so often and look
 * broken. Caught in a dry run before the outreach job went live.
 */
export function stripSelfEcho(s: string): string {
  // Split after . ! ? but NOT when a digit follows: "109.3%" is one number, not
  // two sentences. Splitting there and rejoining inserted a space and printed
  // "109. 3%", which is worse than the echo, since the figures are the whole
  // reason anyone trusts this account.
  const parts = s.split(/(?<=[.!?])(?!\d)/).map((p) => p.trim()).filter((p) => p.length);
  if (parts.length < 2) return s;
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key.length > 12 && seen.has(key)) continue; // short fragments may legitimately recur
    seen.add(key);
    kept.push(p.trim());
  }
  return kept.join(" ");
}

/** Normalize a raw model reply into something postable. */
export function cleanReply(raw: string): string {
  const s = stripDashes(raw ?? "")
    .trim()
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return stripSelfEcho(s).trim();
}

/**
 * Did the model DECLINE to reply, however it phrased it?
 *
 * The prompts ask for the literal token "SKIP", and the callers only tested
 * /^skip\b/. But a model asked to decide often narrates the decision instead of
 * emitting the token — "I'm skipping this one. It's pure price hype and
 * whale-tracking bait." Twenty-one of those were sent to X as REAL REPLIES,
 * publicly telling people their post wasn't worth answering. Only an unrelated
 * API failure stopped them from publishing.
 *
 * Scoped to the opening of the reply: a genuine reply may well use the word
 * ("you can skip the manual step"), but the decision to decline is always
 * stated up front.
 */
export function isSkip(reply: string): boolean {
  const text = (reply ?? "").trim();
  if (!text) return true;
  // Strip markdown emphasis before matching. A model told to emit "SKIP" very
  // often emits "**SKIP**", and the leading asterisks defeated /^skip\b/ — four
  // of Merd's private skip rationales ("Easy pass", "Replying at all puts my
  // account next to price calls") were handed to X as public replies. Only the
  // reply-permission 403 stopped them from publishing, which is luck, not a
  // guard. X renders none of these characters anyway, so dropping them costs
  // nothing and closes the whole family: **SKIP**, _skip_, `SKIP`, > SKIP.
  const head = text.slice(0, 140).toLowerCase().replace(/[*_`>#~]/g, "");
  // Match the SUBJECT of the skipping, not the word. "I'm skipping this one" is
  // a decision; "you can skip the manual retry" is ordinary English inside a
  // real reply, and an earlier version of this guard suppressed exactly that.
  if (/^\s*skip\b/.test(head)) return true;                                   // the literal token the prompt asks for
  if (/^\s*\(?\s*(post|reply|response)\s+skipp?ed\b/.test(head)) return true; // "(Post skipped: pure price hype)"
  if (/\b(i'?m|i am|i'?ll|i will|i'?d|i would|going to|gonna)\s+(just\s+)?skipp?(ing|ed)?\b/.test(head)) return true;
  if (/\bskipping this\b|\bskip this one\b|\bskip criteria\b/.test(head)) return true;
  // Decision-narration without the word: the model explaining, in the third
  // person, which rule the tweet trips instead of writing to the human.
  if (/\bfalls under\b|\bdoes not (meet|clear) the bar\b|\bnothing (genuinely )?(useful|new|of value) to add\b/.test(head)) return true;
  if (/\bi'?ll pass\b|\bno reply\b/.test(head)) return true;
  return false;
}

/**
 * Hard content boundaries. The prompt asks the model not to write these; this
 * is what catches it when the model is wrong, which is the only case that
 * matters. Phrase-based on purpose: a bare /token/ would false-positive on
 * "tokenized stocks", which is core vocabulary.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\$merd\b|\btge\b|\bairdrop|\bpresale|\bpre-sale|\bcontract address|\btoken launch|\btoken sale|\bour token\b|\bthe token\b|\bticker\b|\bwhitelist\b/i, "token/launch content"],
  // Token launching is built but NOT announced. The rule above was written to
  // stop Merd shilling a token of his own, and it does not cover him announcing
  // that USERS can launch one — a different sentence that sailed straight
  // through ("your agent can deploy a token for you now" passed clean). Until
  // this ships deliberately, it is not his to reveal. Scoped to launching a
  // token specifically so ordinary market talk ("the ETF launch", "launched in
  // 2019") is untouched.
  [
    // Verb STEMS with \w*, not whole words: "creating" is creat+ing, so
    // create(ing)? never matches it and the sentence leaks.
    /\blaunchpad\b|\blaunch styles?\b|\b(launch|deploy|mint|creat|spin)\w*\s+(a|an|your|their|our|his|her|its|my|new|own)\s+(own\s+)?(token|coin|memecoin)\b/i,
    "unannounced launch feature",
  ],
  // The MERD launch itself. Everything above was written before the token, the
  // hook, the lock and the buyback existed, and a probe of nine plausible
  // sentences about them found that ALL NINE passed clean — including a bare
  // contract address. These close that.
  //
  // The ticker cannot be matched case-insensitively: the agent is named Merd,
  // so /\bmerd\b/i would gag him saying his own name in every post. Case IS the
  // signal — prose writes "Merd", a ticker shouts "MERD".
  [/\bMERD\b/, "MERD ticker"],
  // A 40-hex address has no legitimate reason to appear in a post, ever.
  [/0x[0-9a-fA-F]{40}\b/, "contract address"],
  [/\bMeridian(TreasuryHook|PositionLock|Buyback|Token)\b|\btreasury hook\b|\bposition lock\b/i, "contract names"],
  [/\bbuy ?backs?\b|\bbuy(ing)? back and burn|\bburn(ing|s)? (pons|index|supply)\b|\bdeflationary\b/i, "buyback and burn"],
  [/\bfair launch\b|\blaunch tax\b|\bdecay(ing)? (tax|fee)\b|\bsniper?s?\b|\banti-?sniper\b/i, "launch mechanics"],
  [/\b(lp|liquidity) (is )?lock(ed)?\b|\block(ed)? (lp|liquidity)\b|\bno withdraw function\b|\brenounced?\b/i, "liquidity lock claims"],
  [/\bvanity address\b|\bmin(e|ed|ing) (a |an |the )?(vanity |hook )?address\b|\bcreate2\b|\bsalt\b/i, "deployment internals"],
  // Naming the mechanism gives the game away as surely as naming the token:
  // "our v4 hook" tells a reader a launch is being built.
  [/\b(v4|uniswap|our|the) hook\b|\bhooks?\b.{0,20}\b(fee|tax|swap)\b|\bfee schedule\b/i, "hook mechanics"],
  [/\bunaudited\b|\bvulnerab|\bexploit\b|\bfail.?open\b|\bsecurity (hole|flaw|issue|bug|gap)|\bnot been audited\b/i, "security disclosure"],
  [/@robinhood|\bpartnered? with robinhood|\bpartnership with robinhood|\bbacked by robinhood/i, "implied Robinhood affiliation"],
  [/\bfinancial advice\b|\bguaranteed?\b|\bwill (moon|pump|hit \$)/i, "advice or price promise"],
  // Launch-timing hints. Merd is allowed to answer impatient people warmly, but
  // "soon" IS an answer to "wen", and these phrases only ever appear when
  // someone is signalling a date they have been told not to give.
  [/\b(days?|weeks?|hours?) away\b|\bnot long now\b|\bany day now\b|\bcoming (soon|shortly)\b|\bstay tuned\b|\bmark your calendar/i, "launch timing hint"],
];

/** Returns a reason string if the text must not be posted, else null. */
export function forbiddenReason(text: string): string | null {
  for (const [re, why] of FORBIDDEN) {
    const hit = text.match(re);
    if (hit) return `${why}: matched "${hit[0]}"`;
  }
  return null;
}

const STOP = new Set(
  "the a an and or but of to in on at is are was were it its this that for with as by from you your i my we our they them there here now just still like about into over under more most some any all not no than then so if while when what which who how why be been being have has had do does did can could would should will".split(" "),
);

const words = (s: string): Set<string> =>
  new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );

/**
 * Meaningful word overlap, 0..1, against the smaller set so a short post is not
 * unfairly diluted by a long one. Catches rewordings; does NOT catch a repeated
 * theme in different words, which stays the prompt's job.
 */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Highest similarity against any recent post, with the offender. */
export function tooSimilar(text: string, recent: string[], max = 0.45): { hit: string; score: number } | null {
  for (const r of recent) {
    const score = similarity(text, r);
    if (score >= max) return { hit: r, score };
  }
  return null;
}

const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion";

/**
 * Distinctive figures in a piece of text, digits and spelled-out alike.
 *
 * Word-overlap similarity cannot catch a repeated signature stat: two replies
 * that both lean on "fifty-six venues" but differ everywhere else score ~0.20
 * and sail through, while a reader sees the same talking point twice. This
 * compares the numbers themselves.
 */
export function statTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, ""));
  for (const m of s.toLowerCase().matchAll(new RegExp(`\\b(${NUMBER_WORDS})(?:[- ](${NUMBER_WORDS}))?\\b`, "g"))) {
    out.add(m[0].replace(/\s+/g, "-"));
  }
  return out;
}

/** A figure this text shares with any earlier one, or null. */
export function repeatedStat(text: string, earlier: string[]): string | null {
  const mine = statTokens(text);
  if (!mine.size) return null;
  for (const prev of earlier) {
    for (const t of statTokens(prev)) if (mine.has(t)) return t;
  }
  return null;
}

/**
 * Junk filter for OTHER people's tweets, deciding what is even worth reading.
 * Robinhood Chain search is heavy with launchpad promos, giveaway farming, and
 * pump chatter that Merd must never be seen replying to.
 */
const JUNK: RegExp[] = [
  /\b(presale|pre-sale|whitelist|airdrop|giveaway|free mint|claim now|1000x|100x|moon(ing|shot)?|pump|ape in|degen play)\b/i,
  /\b(launchpad|fair launch|stealth launch|liquidity locked|dev doxxed|next gem|low ?cap)\b/i,
  /\b(dm me|check my bio|link in bio|join (our|the) (tg|telegram|discord)|follow.{0,12}retweet)\b/i,
  /(\$[A-Za-z]{2,10}\b.*){4,}/,           // cashtag spray
  /(#\w+\s*){4,}/,                         // hashtag stuffing
];

export function isJunk(text: string): boolean {
  return JUNK.some((re) => re.test(text));
}
