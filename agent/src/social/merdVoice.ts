// Merd's voice. Composes tweet candidates from REAL signal values only — never
// invents a number. Grounded, first-person, disciplined (Merd watches and waits
// for an edge rather than hyping). The composer returns candidates; a human (or
// the cadence loop in draft mode) decides what actually posts.

const MAX = 275; // leave headroom under X's 280

export interface MerdSignals {
  decision?: { action?: string; reason?: string; thoughts?: string[] } | null;
  topYield?: { label?: string; aprPct?: number; trend?: string } | null;
  perp?: { markets?: number; volumeUsd24h?: number; busiest?: { symbol?: string; usd?: number } } | null;
  basisGap?: { symbol?: string; basisPct?: number; marketState?: string } | null;
  milestone?: string | null;
}

const usd = (n?: number) =>
  n == null ? "" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

const clip = (s: string) => (s.length <= MAX ? s : s.slice(0, MAX - 1).trimEnd() + "…");

/**
 * Turn live signals into a set of tweet candidates in Merd's voice. Every number
 * comes straight from the inputs — nothing is fabricated. Order = rough priority.
 */
export function composeMerdTweets(s: MerdSignals): string[] {
  const out: string[] = [];
  const covered = new Set<string>(); // topics a structured tweet already handled

  // 1. A disciplined market read — the "watching, not chasing" posture that is
  //    Merd's whole personality. Pulled from its live decision.
  const thoughts = (s.decision?.thoughts ?? []).map((t) => t.trim()).filter(Boolean);
  const discipline = thoughts.find(
    (t) => /staying out|step(ping)? aside|not chasing|chasing informed|patien|by design|sitting (this )?out/i.test(t) && !/perp|venue|scanned|polled|mapping/i.test(t),
  );
  if (discipline) out.push(clip(discipline.replace(/^Book:\s*/i, "The book: ")));

  // 2. Perp-venue pulse — a concrete "here's the market right now" post.
  if (s.perp?.markets && s.perp.volumeUsd24h) {
    const b = s.perp.busiest;
    out.push(
      clip(
        `Scanned the RWA perp venue: ${s.perp.markets} markets, ~${usd(s.perp.volumeUsd24h)} in 24h flow` +
          (b?.symbol ? `. Busiest book: ${b.symbol} at ${usd(b.usd)}.` : ".") +
          ` I move when the edge shows, not before.`,
      ),
    );
    covered.add("perp");
  }

  // 3. Yield note — honest about the trend, never a shill.
  if (s.topYield?.label && s.topYield.aprPct != null) {
    // "cooling" is the word the yield logger actually uses for a falling trend,
    // and it matched none of these — so a cooling yield was being announced as
    // "And climbing.", which is the one thing this composer must never do.
    // Stems, not whole words — "easing" is eas+ing, so /ease/ never matches it.
    // postGuards learned this the same way; it is the second time in this file's
    // history that a whole-word verb has let something through.
    const falling = /fall|down|declin|cool|soften|eas(e|ing|ed)|slip|fad/i.test(s.topYield.trend ?? "");
    out.push(
      clip(
        `Best accessible yield on my board right now: ${s.topYield.label} at ${s.topYield.aprPct.toFixed(0)}% implied APR.` +
          (s.topYield.aprPct > 150
            ? ` That's volume-driven and it swings hard, so I read it with a raised eyebrow, not a victory lap.`
            : falling
              ? ` Cooling from its highs, but still the one to beat.`
              : ` And climbing.`),
      ),
    );
    covered.add("yield");
  }

  // 4. Basis gap — the off-hours edge, when there is one worth naming.
  if (s.basisGap?.symbol && s.basisGap.basisPct != null && Math.abs(s.basisGap.basisPct) >= 0.15) {
    const dir = s.basisGap.basisPct < 0 ? "under" : "over";
    out.push(
      clip(
        `${s.basisGap.symbol}'s on-chain price is ${Math.abs(s.basisGap.basisPct).toFixed(2)}% ${dir} its real-market print right now.` +
          ` The gap is the trade. It closes at the open, and it's what I watch while the market sleeps.`,
      ),
    );
  }

  // 5. Any other substantive thought, reframed lightly.
  for (const t of thoughts) {
    if (covered.has("perp") && /perp/i.test(t)) continue;
    if (covered.has("yield") && /yield|apr|distribution|syrup/i.test(t)) continue;
    if (out.some((o) => o.includes(t.slice(0, 24)))) continue;
    out.push(clip(t));
    if (out.length >= 6) break;
  }

  // 6. Milestone, if one was passed (e.g. a signups round number).
  if (s.milestone) out.push(clip(s.milestone));

  // Dedupe on a normalized core so a lightly-reframed thought ("The book:" vs
  // "Book:") isn't emitted twice. Keep original order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of out) {
    if (t.length <= 40) continue;
    const key = t.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "").slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(t);
  }
  return result;
}
