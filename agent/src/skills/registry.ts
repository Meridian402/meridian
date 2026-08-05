// The agent skills suite: composable capabilities a creator's agent can turn
// on, each PROVEN on the house desk before it is sold. The catalog is honest
// about state, custody, and price on purpose; a skill marked "planned" is a
// promise, not a product, and the site must render it as one.
//
// Hard boundary, on the record: there is no wash-trading / fake-volume skill,
// not now, not planned. Trading a token against itself to fake demand is
// market manipulation and the exact toxicity our own analyzer exists to flag.
// The honest way to make a token trade well is the market-making skill: real
// two-sided liquidity produces real volume that survives scrutiny.

export type SkillState =
  | "live" // usable today, end to end
  | "prepare-only" // produces a signable plan; execution layer pending custody model
  | "planned"; // designed, not built

export type SkillCustody =
  | "read-only" // touches no funds
  | "self-custody-sign" // creator signs every action from their own wallet
  | "funded-runner"; // creator funds a dedicated wallet they alone can drain

export interface Skill {
  id: string;
  name: string;
  summary: string;
  state: SkillState;
  custody: SkillCustody;
  /** Honest pricing note; not a quote. */
  pricing: string;
  /** Where it was proven, if it was. */
  provenOn?: string;
}

export const SKILLS: Skill[] = [
  {
    id: "market-making",
    name: "Market-making desk",
    summary:
      "Your token wakes up with the same desk that runs Merd: two-sided quotes, rotation to the market, velocity-aware placement, and a never-stuck exit ladder. Real liquidity, so the volume is real.",
    state: "prepare-only",
    custody: "funded-runner",
    pricing: "0.1 ETH to arm on a launch, then a share of the fees the desk earns for you",
    provenOn: "the house desk (live since 2026-08-04)",
  },
  {
    id: "supply-commit",
    name: "Supply commitment",
    summary:
      "Burn or time-lock any slice of supply through a locker whose source is read before it is trusted, and get the receipts as a thread. Exactly what Merd did to its own supply.",
    state: "prepare-only",
    custody: "self-custody-sign",
    pricing: "flat per action, plus the locker's own on-chain fee",
    provenOn: "Merd supply: ~19.9% burned, 67.7M locked (2026-08-04)",
  },
  {
    id: "narration",
    name: "Public narration",
    summary:
      "A journaled decision feed and a timeline voice that posts what the agent actually did, receipts included, losses told straight. The thing that makes an account credible instead of noisy.",
    state: "prepare-only",
    custody: "read-only",
    pricing: "per-post metered, or a daily subscription",
    provenOn: "@Meridian402",
  },
  {
    id: "runner-wallet",
    name: "Runner wallet",
    summary:
      "A dedicated hot wallet for a skill to operate from, funded by you and drainable only by you: the same execution/treasury split the house desk runs on. The substrate the other skills sit on.",
    state: "planned",
    custody: "funded-runner",
    pricing: "included with any skill that needs one",
  },
];

export function listSkills(): Skill[] {
  return SKILLS;
}
