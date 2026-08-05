# Agent skills: the Meridian launchpad's product surface

Reference for the skills suite a creator's agent can turn on. System of
record: this file plus `src/skills/*` and `src/deploy/myAgent.ts`. Product
frame decided 2026-08-05.

## The one-line pitch

Launch a token on Meridian and it does not arrive naked. It arrives with the
same operational stack Merd runs on itself: a market-making desk, a public
decision journal, supply commitments with receipts, a treasury that only
receives. Every skill was proven on the house desk with real money before it
was offered to anyone else.

Pons has a bonding curve. ClawPump has custody. lunch.fun has a locker. None
of them hand a token an agent that runs it like a business afterward. That is
the category, and it is the only defensible reason to launch here.

## Hard boundary (on the record, enforced by test)

There is **no wash-trading / fake-volume skill**, now or planned. Trading a
token against itself to fake demand is market manipulation, it is the exact
toxicity the analyst (`signals/tokenAnalyst.ts`) exists to detect and refuse
in other pools, and shipping it would make Meridian the thing it grades others
against. `test/skills.test.ts` asserts no skill summary advertises fake volume.

What a creator actually wants, a token that trades well, is produced honestly
by the market-making skill: real two-sided liquidity makes a token cheap to
trade, which pulls real flow, which is volume that survives an audit. Sell the
liquidity, not the illusion.

## The catalog (`src/skills/registry.ts`)

Each skill carries an honest `state` and `custody`. The site must render those
truthfully; a `planned` skill is a promise, not a product.

| Skill | State | Custody | Proven on |
| --- | --- | --- | --- |
| Market-making desk | prepare-only | funded-runner | the house desk (live 2026-08-04) |
| Supply commitment | prepare-only | self-custody-sign | MERD supply: ~19.9% burned, 67.7M locked |
| Public narration | prepare-only | read-only | @Meridian402 |
| Runner wallet | planned | funded-runner | (the substrate the others need) |

`state`: `live` = usable end to end · `prepare-only` = produces a signable
plan, execution layer pending the custody model · `planned` = designed, not
built.

## The custody fork (the decision that gates execution)

Skills split cleanly by how they touch funds, and the split decides the build:

- **One-shot actions** (a launch, a lock, a burn) are **self-custody-sign**:
  the backend prepares unsigned calldata, the creator signs from their own
  wallet. This pattern is already live for launches (`launch/pons.ts` +
  `LaunchCard`), the reference implementation for every one-shot skill.
- **Standing actions** (a 24/7 market-making desk) cannot ask a human to sign
  every 10-minute re-quote. They need a **funded-runner**: a dedicated hot
  wallet the creator funds and alone can drain, exactly the
  execution/treasury split the house desk already runs
  (`memeGuard.ts` + `merd/wallets.ts`). The creator delegates a bounded float;
  the runner never holds a key to more than that float; the creator sweeps it
  back anytime.

The funded-runner model is the open build. It is safe by construction (the
runner can only ever lose the float the creator chose to fund) but it is real
key-management work and must not be rushed. Until it lands, the MM skill ships
`prepare-only`: it tells a creator whether the desk *can* quote their token and
at what price (`skills/marketMaking.ts`, `assessTokenForMM`), which is the
honest front door.

## Read this before building the runner

- The launch tool (`meridian_launch_token_pons`) is deliberately
  unauthenticated on `/mcp`: safe only because signing is manual. The moment
  any auto-sign or session-key path exists, that assumption breaks. A
  funded-runner is a session key. Authenticate the arming step.
- PONS launches create Uniswap **v3** pools; the desk is **v4**. The MM skill
  cannot quote a PONS-launched token until either the desk speaks v3 or
  Meridian ships a v4-native launch. This is the single biggest gap between
  the launch product and the MM skill, and the reason the 0.1 ETH deploy fee
  belongs on a v4-native path where the entitlement is real on day one.

## Monetization

- **Deploy fee:** 0.1 ETH to launch with the desk attached (v4-native path).
- **Per-skill:** MM takes a share of the fees it earns the creator (aligned
  with the token succeeding, not with churn). Narration is metered or
  subscription. Supply commitment is flat per action plus the locker's own fee.
- **No commission on which venue a launch uses.** The old Flap commission paid
  the agent to steer users into the worst product; it was deleted on purpose
  (`deploy/myAgent.ts`). Do not rebuild that conflict of interest.

## Endpoints

- `GET /api/skills` — the catalog, honest state and custody. Public.
- `GET /api/skills/mm/assess?token=0x...` — can the desk quote this token, at
  what price, structural gate (initialized + has liquidity), read-only.

## Build order

1. **MM assess (done):** the read-only front door.
2. **Runner wallet:** the funded, creator-drainable execution wallet. The
   substrate. Authenticated arming.
3. **MM execute:** point the rotor at a runner wallet + a creator's token.
   The house desk's own code, parameterized by wallet and venue.
4. **v4-native launch:** so the deploy fee buys a real desk entitlement, not a
   PONS v3 pool the engine cannot touch. Long pole: the hook/lock/seed
   contracts (`contracts/*.sol`) are DRAFT/UNAUDITED and need fork tests + an
   audit before real money.
