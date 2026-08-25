# The Engine Vault: deposit USDG, Merd works it

Drafted 2026-08-26 from operator decisions. Status: SPEC ONLY, no contract.
The flagship tier of engine access: pooled USDG worked by the engine 24/7 in
the same seat pools as the house desk, with the trust pattern the ladder
vault established. The self-serve engine remains as the sovereign tier.

## The decisions this encodes (operator, 2026-08-26)

1. **Product shape: vault flagship + self-serve tier.** The vault is the
   headline ("deposit and Merd works it"); the non-custodial self-serve
   engine stays for wallets that want full control. The access gate
   (stake 2.5M MERD / hold a Meridian / graduated launch) applies to both.
2. **Performance fee: 20% of vault earnings to the treasury.** Fees only,
   never principal, enforced in the contract at harvest accounting. No
   earnings, no fee.

## Mechanism (sketch)

- `deposit(usdg)`: gated wallets only. USDG in, shares out.
- The engine, as the vault's BOUNDED MANAGER, opens/re-centers/collects
  seat-pool positions with vault capital using the same brain as the house
  desk (computeMintPlan, the guard gates, the same anti-churn discipline).
- `harvest()`: collected fees account 80/20 (depositors/treasury).
- `withdraw(shares)`: fluid and self-serve, same invariant as the ladder
  vault: one transaction, any time, no lock, no queue, no manager needed.

## Manager bounds (bytecode, AgentTreasury pattern)

- CAN: mint/decrease/collect positions ONLY in an immutable allowlist of
  pool keys (the seat pools); hold vault USDG idle.
- CANNOT: withdraw to any address, ever; touch tokens outside the allowlisted
  pools; change the fee.
- Owner: set manager, pause DEPOSITS only (never withdrawals), adjust the
  deposit cap downward or upward within an immutable hard ceiling.

## Capacity, stated as a first-class constraint

The edge lives in thin pools; capital dilutes returns for everyone including
the house desk. The contract carries a `depositCap` (owner-set under an
immutable ceiling), and the honest public framing is that the cap is a
feature: the vault stays small enough to earn.

## THE HARD PROBLEM (unresolved; decides the contract's shape)

Share pricing over mixed assets. The vault holds USDG plus two-sided LP
positions whose token side needs a price to value, and every price source on
thin pools is a manipulation surface (deposit/withdraw sandwiches, share
inflation). The ladder vault dodged this by denominating principal in one
asset; the engine vault cannot fully, because its positions are two-sided by
nature. Candidate solves, to be settled before code:

- **Exit by execution, not by oracle**: `withdraw` decreases the user's
  pro-rata slice of every open position and swaps the token side to USDG
  through the same pool inside the exit transaction, with a caller-set
  minimum-out. The realized execution IS the price; no oracle anywhere.
  Cost: exit gas scales with open positions; exits pay their own slippage
  (fair: they impose it).
- **Entry at cash-plus-marked NAV with damping**: deposits price shares
  against USDG plus positions valued at pool spot, but with a deposit cap
  per transaction, a same-block deposit/withdraw ban, and a small entry
  haircut accruing to existing depositors, so manipulating spot against the
  vault costs more than it yields. Uglier than the exit story; needs
  adversarial modeling before acceptance.
- **Epoch entries**: deposits queue and mint at the next harvest boundary
  when marks are freshest. Cleaner pricing, worse UX; conflicts with the
  fluidity bar unless only ENTRIES are epoched (exits stay instant).

Current lean: execution-priced exits (instant, oracle-free) plus epoched
entries (queue to the next harvest, minutes not days). Both sides then need
no oracle at all. To be confirmed before code.

## Honest public framing (for the eventual page)

- Returns are variable and CAN BE NEGATIVE; shares mark to a trading book.
  The engine's guards cap drawdowns; they do not erase them.
- The 20% fee applies to earnings only; a losing period pays Meridian zero.
- The cap exists because the strategy has real capacity; this is said as
  plainly as everything else on the site.
- This product is closer to managed money than anything else Meridian runs,
  even with the manager fenced in bytecode. External audit is a hard gate,
  and the regulatory character is acknowledged internally, not papered over.

## Open items before code

- Settle the share-pricing solve (above).
- Gate check at deposit only, or continuously (lapsed access blocks new
  deposits but never exits)?
- The initial deposit cap and its immutable ceiling, from measured pool
  capacity (the desk's own capture data is the input).
- Whether house capital co-invests in the vault or stays a separate book
  (separate preserves clean accounting; co-invest aligns incentives).
