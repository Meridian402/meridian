# Agent identity registry (parked, not deleted)

A minimal ERC-721 that gives each user's agent a public on-chain identity: one
token per wallet, self-minted, holding nothing. Built and passing (12 unit tests
plus a 6551 fork proof) before it was parked. Nothing here is wrong.

## Why it is out of the build

It is the only thing in this repo that needs OpenZeppelin, and adding
`@openzeppelin/contracts/=...` to `remappings.txt` **changes the compiled
bytecode of every contract in the project**, not just this one. Solidity records
the remapping list in each contract's metadata, and the metadata hash is
appended to the bytecode.

MERD's hook, lock and token addresses are CREATE2 addresses mined against exact
bytecode. The hook's address in particular has to carry the v4 permission bits
in its low 14 bits or the pool silently never calls it. So adding this one
import invalidated all three mined addresses at once, which is what
`agent/test/merd-deploy-*.test.ts` started failing on.

`MeridianStaking.sol` had the same problem and was fixed differently: it only
needed `mulDiv`, so it now uses `v4-core`'s `FullMath`, which is the same
512-bit algorithm from a dependency we already had. This contract needs ERC721,
Base64 and Strings, which v4-core does not provide, so there is no equivalent
swap available.

## To bring it back

1. Move these three files into `contracts/` and `contracts/test/`.
2. Add `@openzeppelin/contracts/=lib/v4-core/lib/openzeppelin-contracts/contracts/`
   to `remappings.txt`.
3. `forge clean && forge build`, then **re-mine all three MERD addresses**
   (hook, lock, token) and update `agent/src/merd/merd.ts`. The
   `merd-deploy-*` tests are the check that you did it correctly.

Step 3 is the real cost, and it is why this is parked rather than shipped: it is
not worth changing MERD's launch identity for a feature that is not on the
critical path. Once MERD is actually deployed, its addresses are fixed forever
and this constraint disappears, so the natural time to revisit is after launch.

## The general lesson

Any new remapping is a breaking change to every mined address in this repo.
Prefer a library that is already remapped. If a new dependency is genuinely
required, expect to re-mine.
