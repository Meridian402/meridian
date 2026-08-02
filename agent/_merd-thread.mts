// Post a fixed, operator-authored thread: the first item is a top-level post,
// each later item replies to the one before, and every item may carry an image.
// The captions are ours (a thread has to be coordinated with its pictures, which
// the autonomous voice cannot do), but they still pass the SAME content guards
// every post passes. DRY_RUN=1 prints the whole thread and posts nothing.
import { existsSync } from "node:fs";
import { postTweet, postReply } from "./src/social/xClient.js";
import { forbiddenReason, cleanReply } from "./src/social/postGuards.js";

const DRY = process.env.DRY_RUN === "1";

interface Item { text: string; image?: string }

// The thread. Edit here; nothing is read from the model.
const DIR = new URL("./scratch/infographics/", import.meta.url).pathname;
const THREAD: Item[] = [
  {
    text: "your own agent on robinhood chain. you connect a wallet and that is the entire signup, no email, no account. it watches tokenized stocks around the clock, including the hours the real market is shut, and tells you straight what it sees. a short thread on how it fits together.",
    image: DIR + "card1.png",
  },
  {
    text: "what the desk is actually doing right now. 62 tokenized-rwa venues mapped on-chain, most of them found by agents out scouting. 18 equities tracked in pools that trade every hour of the week. these are live numbers, not projections.",
    image: DIR + "card2.png",
  },
  {
    text: "the part i find genuinely new. the agents pay each other. one agent buys a market read from another over x402, settled on-chain, no account sitting in the middle. a small economy between machines, and it is real.",
    image: DIR + "card3.png",
  },
  {
    text: "the part most platforms bury. meridian never takes custody. the agent proposes, you sign, every position leaves your own wallet. there is no deposit and nothing to withdraw, because nothing was ever held. meridian402.xyz",
    image: DIR + "card4.png",
  },
];

// Guard + length + image-exists check BEFORE any network call, so the thread
// either goes out whole or does not start. A half-posted thread is worse than
// none.
const MAX = 500;
let bad = false;
for (const [i, it] of THREAD.entries()) {
  const text = cleanReply(it.text);
  it.text = text;
  const reason = forbiddenReason(text);
  const problems = [
    reason ? `BLOCKED: ${reason}` : null,
    text.length > MAX ? `too long (${text.length})` : null,
    it.image && !existsSync(it.image) ? `image missing: ${it.image}` : null,
  ].filter(Boolean);
  console.log(`\n[${i + 1}/${THREAD.length}] (${text.length} chars)${it.image ? " + " + it.image.split("/").pop() : ""}`);
  console.log(text);
  if (problems.length) { console.log("  " + problems.join(" · ")); bad = true; }
}
if (bad) { console.log("\nthread has problems, nothing posted."); process.exit(1); }
if (DRY) { console.log("\nDRY RUN, nothing posted."); process.exit(0); }

// Post the chain. The anchor is a top-level post; each reply targets the id of
// the item before it, so X renders one thread.
let prevId: string | undefined;
const links: string[] = [];
for (const [i, it] of THREAD.entries()) {
  const r = prevId ? await postReply(it.text, prevId, it.image) : await postTweet(it.text, it.image);
  if (!r.posted || !r.id) {
    console.log(`\nSTOPPED at item ${i + 1}: ${r.reason}. ${links.length} of ${THREAD.length} posted.`);
    for (const l of links) console.log("  " + l);
    process.exit(1);
  }
  prevId = r.id;
  links.push(`https://x.com/Meridian402/status/${r.id}`);
  console.log(`posted ${i + 1}/${THREAD.length}: ${links[links.length - 1]}`);
}
console.log("\nthread live:");
for (const l of links) console.log("  " + l);
