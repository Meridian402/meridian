import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import { spawnSync } from "node:child_process";
import { assertSignerIsHouseWallet } from "../src/venues/signer.js";

/**
 * Mirror of the treasury allowlist, for the signing key: merd/wallets.ts pins
 * the house wallet, and a process whose key derives to anything else must
 * refuse to boot rather than sign from a wallet that role separation, the
 * docs and the published track record do not follow.
 *
 * Order matters: the keyless case runs first because getAgentSigner caches
 * the first key it ever sees.
 */

test("a keyless (read-only) process has nothing to assert", () => {
  delete process.env.AGENT_SIGNER_PRIVATE_KEY;
  assert.doesNotThrow(() => assertSignerIsHouseWallet());
});

test("a key that wallets.ts does not know is refused", () => {
  process.env.AGENT_SIGNER_PRIVATE_KEY = generatePrivateKey();
  assert.throws(() => assertSignerIsHouseWallet(), /wallets\.ts/);
});

test("a bare-hex key (no 0x prefix) is accepted, because wallets export both shapes", { timeout: 90000 }, () => {
  // The 2026-07-27 outage: a VALID key, pasted in the shape the wallet handed
  // over, crash-looped prod at boot on a viem internal. Both shapes and stray
  // whitespace must derive to the same address. Subprocesses because
  // getAgentSigner caches the first key it sees.
  const prefixed = generatePrivateKey();
  const probe =
    "import(process.env.SIGNER_MOD).then(m => console.log(m.getAgentSigner().address)).catch(e => console.log('THREW:' + e.message.slice(0, 60)));";
  const run = (key: string) =>
    spawnSync("npx", ["tsx", "--eval", probe], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 45000,
      env: { ...process.env, SIGNER_MOD: new URL("../src/venues/signer.ts", import.meta.url).href, AGENT_SIGNER_PRIVATE_KEY: key },
    }).stdout.trim();

  const expected = run(prefixed);
  assert.match(expected, /^0x[0-9a-fA-F]{40}$/, "the prefixed form must derive an address");
  assert.equal(run(prefixed.slice(2)), expected, "bare hex must derive the same address");
  assert.equal(run(`  ${prefixed}  `), expected, "surrounding whitespace must not matter");
});

test("a key that is not 64 hex characters is refused by name, not by a viem internal", { timeout: 60000 }, () => {
  // Subprocess for the same reason as above: by this point in the file
  // getAgentSigner has cached a valid key, and an in-process call would never
  // reach the parser at all.
  const probe =
    "import(process.env.SIGNER_MOD).then(m => { try { m.getAgentSigner(); console.log('NO-THROW'); } catch (e) { console.log(e.message); } });";
  const out = spawnSync("npx", ["tsx", "--eval", probe], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    timeout: 45000,
    env: { ...process.env, SIGNER_MOD: new URL("../src/venues/signer.ts", import.meta.url).href, AGENT_SIGNER_PRIVATE_KEY: "not-a-key" },
  }).stdout;
  assert.match(out, /AGENT_SIGNER_PRIVATE_KEY is not a private key/);
});
