# Meridian custody — the recipient-pinning design

**Status: design + unaudited draft. Not deployed. Must be built, tested, and
externally audited before it holds any real user funds.**

## The one property that matters

A user's funds live in a Safe they solely own. Meridian holds a **session key**,
scoped by a Zodiac Roles module, that can trade those funds but must be unable
to *withdraw* them — even if the session key (or the backend's master secret)
is fully compromised.

## Why scoping the router is not enough

The session key trades through Uniswap v4's `UniversalRouter.execute(bytes
commands, bytes[] inputs, uint256 deadline)`. **The payout recipient of a swap
is a parameter** — it lives inside a `TAKE` action, which is ABI-encoded inside
`inputs[i]` (itself `bytes`), inside the `inputs` array. It is triply-nested
dynamic data.

Zodiac Roles conditions match calldata along ABI-decodable paths. A nested
`bytes` blob can only be matched as **one opaque value** — you can require the
whole blob to equal a constant, but not pin a sub-field. Pinning the recipient
that way would freeze the entire trade (amounts, path, everything), which
defeats dynamic trading.

So: scoping the session key to `router.execute` (even at the selector level)
stops it from calling *other* contracts, but **does not stop it from swapping
the vault's funds out to an attacker** by setting `TAKE.recipient = attacker`.
This is the hole. Selector scoping alone is **not** a "can't withdraw"
guarantee.

## The fix: a thin, recipient-pinning adapter

> **Status: design, not current behavior.** What ships today in
> `agent/src/custody/vault.ts` scopes the session key to the UniversalRouter's
> `execute` selector **directly**. The recipient-pinning adapter below is the
> audit-phase refinement (see the inline note in `buildScopeSession`), and
> `MeridianVaultRouter.sol` is a draft referenced by nothing else yet. Custody
> is dormant behind `CUSTODY_SESSION_MASTER`; do not enable it expecting the
> property this section describes until vault.ts targets the adapter.

The session key is scoped to call **only** `MeridianVaultRouter` — never the
UniversalRouter directly. The adapter takes trade *intent* (which tokens, how
much, min out) and **builds the router call itself**, setting the payout
recipient to the vault. There is no recipient parameter for the caller to abuse.

```
session key ──execTransactionWithRole──▶ Roles module ──▶ Safe (vault)
                                                              │ calls
                                                              ▼
                                                    MeridianVaultRouter
                                              (recipient := vault, hardcoded)
                                                              │
                                                              ▼
                                                       UniversalRouter
                                                              │ output ──▶ vault
```

Because the adapter is called *by the Safe* (via the module), `msg.sender ==
the vault` inside the adapter. The adapter pulls `tokenIn` from the vault, swaps
via the router with `recipient = msg.sender`, and (belt-and-suspenders) sweeps
any residual balance back to `msg.sender`. **Proceeds can only ever land in the
vault.**

### What a compromised session key can and cannot do, under this design

- **Cannot** send funds to any external address. Every path returns to the vault.
- **Cannot** touch any contract but the adapter (Roles scope).
- **Can** churn the vault's assets (swap USDG↔stock repeatedly), bleeding value
  to fees/slippage. This is *griefing, not theft* — funds stay in the vault —
  and is bounded by: the per-trade USD cap, the global circuit breaker, a
  per-vault rate limit, and (optional) a `tokenOut` allowlist in the adapter.

That residual griefing surface is the reason caps + rate limits stay on, and is
a fraction of the "drain everything" surface that selector-only scoping leaves
open.

## Backend changes this implies (in `agent/src/custody/vault.ts`)

1. **Scope target** becomes the adapter, `allowFunction(adapter,
   swapExactInSingle.selector)` — not the router.
2. **Setup approvals** change: the vault approves the **adapter** to pull its
   tokens (instead of approving Permit2/router directly). The adapter holds a
   one-time Permit2→router approval of its own.
3. **`executeForUser`** builds the adapter call (structured params), not raw
   router calldata. The recipient argument disappears entirely.

None of this is wired until the adapter is written, tested, and audited.

## Open items before production

- Write + unit-test the adapter (Foundry), including native-ETH legs and the
  residual sweep.
- Decide `tokenOut` policy (open, or an on-chain allowlist the adapter enforces).
- External audit of the adapter + the Roles scope config together.
- Then rewire `vault.ts` to the adapter and re-run the Phase 0 proofs against it,
  adding the missing test: *session key attempts a swap with an external
  recipient → must be impossible to express.*
