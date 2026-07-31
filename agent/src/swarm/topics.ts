// What the agents actually talk about. Every opening question is assembled
// from live state: the RWA census the research fleet has built, and the house
// desk's own logged reasoning. Nothing here composes a scenario, a hypothetical
// or an example. If the process has no live state to point at yet, this returns
// null and no exchange runs, because an exchange whose premise we made up is
// worse than an empty feed.
import { universe, decisionLog, market } from "../state.js";
import { sanitizeChunk } from "../deploy/myAgent.js";

export interface SwarmTopic {
  /** the opening question, put to the first speaker verbatim */
  text: string;
  /** the live facts it was built from, so a reader can check the premise */
  facts: string[];
}

const clip = (s: string, max: number): string => {
  const t = sanitizeChunk(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Discoveries (not anchors) the fleet has written most recently. */
function recentDiscoveries() {
  return universe
    .all()
    .filter((v) => !v.isAnchor && v.name)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 12);
}

/**
 * One grounded opening question. `seed` rotates which live fact gets used, so
 * consecutive exchanges do not open on the same sentence; it is an index, not
 * a random draw, so the same state and the same seed always produce the same
 * question.
 */
/**
 * Decisions worth putting to another agent.
 *
 * A decision log is only a conversation premise when it contains NEWS. The
 * house desk holds no capital right now, so it logs the same row forever: all
 * twenty recent entries read `hold` / "scanning the market for opportunities",
 * byte for byte. Feeding that to buildTopic asked the same question eleven
 * times, and the agents did what anyone would, which is argue about the
 * epistemics of a label rather than about a market.
 *
 * The test is measurable rather than a judgement about wording: if every recent
 * decision is identical there is nothing in the log to discuss, so there is no
 * decision topic this round. Distinct rows come back the moment the desk
 * actually does something different.
 */
function informativeDecisions(): ReturnType<typeof decisionLog.recent> {
  const recent = decisionLog.recent(8);
  const distinct = new Map<string, (typeof recent)[number]>();
  for (const d of recent) {
    const key = `${d.action}|${(d.reason ?? "").trim().toLowerCase()}`;
    if (!distinct.has(key)) distinct.set(key, d);
  }
  return distinct.size >= 2 ? [...distinct.values()] : [];
}

/**
 * One grounded opening question, avoiding anything asked recently.
 *
 * `alreadyAsked` is the whole point of the second parameter. Every source here
 * goes stale at its own pace: the census only moves when the research fleet
 * discovers something, the segment spread is one fixed sentence, and the
 * decision log repeats whenever the desk is idle. Rotating a seed across stale
 * sources produces the same handful of questions forever, which is what
 * happened: twenty nine exchanges, eight distinct topics, twenty one exact
 * repeats. Agents share ONE durable session, so they see the duplicates pile up
 * and one of them eventually replies "you have sent me this prompt twice,
 * identically", which is a paid turn spent on our bookkeeping.
 */
export function buildTopic(seed = 0, alreadyAsked: readonly string[] = []): SwarmTopic | null {
  const status = universe.status();
  const discoveries = recentDiscoveries();
  const decisions = informativeDecisions();
  const segments = Object.entries(status.segmentCounts).sort((a, b) => b[1] - a[1]);

  const candidates: SwarmTopic[] = [];

  if (discoveries.length) {
    const v = discoveries[seed % discoveries.length];
    const facts = [
      `census: ${status.totalVenues} venues mapped`,
      `venue: ${v.name}${v.segment ? ` (${v.segment})` : ""}`,
      ...(v.tokenizes ? [`tokenizes: ${clip(v.tokenizes, 120)}`] : []),
      ...(v.confidence ? [`confidence recorded as ${v.confidence}`] : []),
      ...(v.sources?.length ? [`${v.sources.length} source link(s) on file`] : []),
    ];
    candidates.push({
      facts,
      text:
        `Our census has ${status.totalVenues} tokenized RWA venues in it. One of the most recent entries is ${clip(v.name, 80)}` +
        `${v.segment ? `, filed under ${v.segment}` : ""}${v.tokenizes ? `, tokenizing ${clip(v.tokenizes, 120)}` : ""}` +
        `${v.confidence ? `, recorded at ${v.confidence} confidence` : ""}. ` +
        `Working from your own segment: does an entry like this change where you would look next, and what would you need to see before you trusted any number attached to it? ` +
        `Do not invent figures. If you have not seen this venue, say so and reason from what your segment does tell you.`,
    });
  }

  const [topKey, topN] = segments[0] ?? ["", 0];
  // Walk the thin end rather than always naming the single thinnest segment.
  // This was one fixed sentence with no rotation at all, so every time the seed
  // landed here it asked the identical question.
  const tailIdx = segments.length >= 2 ? segments.length - 1 - (seed % Math.min(3, segments.length - 1)) : 0;
  const [thinKey, thinN] = segments[tailIdx] ?? ["", 0];
  // Only worth asking when the coverage is actually lopsided. A "heaviest 1,
  // thinnest 1" opener would be a true sentence and a fake premise.
  if (segments.length >= 2 && topN > thinN) {
    candidates.push({
      facts: [
        `census: ${status.totalVenues} venues across ${segments.length} segments`,
        `heaviest: ${topKey} at ${topN}`,
        `thinnest: ${thinKey} at ${thinN}`,
      ],
      text:
        `Right now the census holds ${status.totalVenues} venues across ${segments.length} segments. The heaviest is ${topKey} with ${topN}; the thinnest is ${thinKey} with ${thinN}. ` +
        `Is that spread telling us something real about where tokenized assets actually are, or is it just where we have looked hardest? Argue for the segment you think is genuinely under-mapped and say why.`,
    });
  }

  if (decisions.length) {
    const d = decisions[seed % decisions.length];
    candidates.push({
      facts: [`house desk decision: ${d.action}`, `strategy: ${d.strategy}`, `stated reason: ${clip(d.reason, 200)}`],
      text:
        `The house desk's logged decision was "${d.action}", from the ${d.strategy} strategy. Its stated reason: "${clip(d.reason, 200)}". ` +
        `From where you sit, does that hold up? Say plainly if you would have argued the other side, and what evidence in your own segment would make you push back on it.`,
    });
  }

  // Live prices. The census fills up over weeks and the decision log needs the
  // trading loop to have run, but the market feed is live from boot, so this is
  // the source that lets a fresh deployment hold a real conversation on day one
  // instead of sitting empty waiting for state to accumulate. Only used when the
  // feed says it is genuinely live: stale seed values are not live state, and
  // opening on them would be exactly the invented premise this file refuses.
  const feed = market.dataSource();
  if (feed.live && feed.liveCount > 0) {
    const assets = market
      .listAssets()
      .filter((a) => typeof a.priceUsd === "number" && typeof a.changePct === "number")
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
    if (assets.length >= 2) {
      const mover = assets[seed % Math.min(assets.length, 5)];
      const calm = assets[assets.length - 1];
      const dir = (mover.changePct ?? 0) >= 0 ? "up" : "down";
      candidates.push({
        facts: [
          `live feed: ${feed.liveCount} of ${feed.assetCount} tokenized equities quoted`,
          `${mover.symbol} at $${mover.priceUsd} (${mover.changePct}% today)`,
          `${calm.symbol} at $${calm.priceUsd} (${calm.changePct}% today)`,
        ],
        text:
          `Live on Robinhood Chain right now: ${mover.symbol} is ${dir} ${Math.abs(mover.changePct ?? 0)}% at $${mover.priceUsd}, while ${calm.symbol} has barely moved at ${calm.changePct}%. ` +
          `Meridian makes markets in pools like these and earns the fee on the flow, so movement is both the opportunity and the risk. ` +
          `From your own beat: is a day like this one to widen ranges and sit still, or one to work the spread harder? Say which of the two names you would rather be quoting and why. ` +
          `Use only the figures given here and do not invent any others.`,
      });
    }
  }

  if (!candidates.length) return null;

  // Prefer something that has not been asked lately. Rotation alone cannot do
  // this: it walks the SOURCES, and a source that has not changed returns the
  // same question however far the seed advances.
  const asked = new Set(alreadyAsked);
  const fresh = candidates.filter((c) => !asked.has(c.text));
  if (fresh.length) return fresh[seed % fresh.length];

  // Everything on hand has been asked recently. Rotating anyway is better than
  // refusing to talk, but say nothing false: the premise is still live state,
  // it is just not new, so the agents are asked to move it on rather than
  // repeat themselves.
  const repeat = candidates[seed % candidates.length];
  return {
    facts: repeat.facts,
    text:
      `${repeat.text}\n\n` +
      `You have been asked about this before. Do not restate your earlier position: ` +
      `say what would have to change your mind, or what you still cannot check.`,
  };
}
