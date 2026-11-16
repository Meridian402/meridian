import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, custom, fallback, http } from "viem";
import { LegBreaker, guardLeg, httpStatusOf, isAccessStatus, redactRpcText, hostOf, type ProbeOutcome } from "../src/venues/rpcBreaker.js";
import { rpcHealth } from "../src/venues/signer.js";

/**
 * THE RPC LEG BREAKER.
 *
 * On 2026-11-16 the desk's dedicated provider turned out to have been
 * answering every call with HTTP 403 for weeks. Reads still worked, because
 * the read client falls back to the public endpoint, but only after the RPC
 * library had retried the dead endpoint four times, on every single read. The
 * basis logger, which had no fallback, wrote 20,000 error rows, each carrying
 * the provider's keyed URL.
 *
 * What must hold: an endpoint that rejects ACCESS is skipped instead of
 * retried forever, real reads never wait on it while it is skipped, it is
 * re-tested by one background probe per cooldown, it comes back on its own, a
 * throttle is never mistaken for a rejection, and no error text that leaves
 * the process contains a URL path.
 *
 * The first version of this read the status off the thrown error. The real
 * transport does not carry it there (see "the real http transport" below), and
 * only an end-to-end run showed that; the unit tests had passed.
 */

const rejected = (status: number) => Object.assign(new Error(`HTTP request failed. Status: ${status}`), { status });

function harness(outcomes: ProbeOutcome[] = []) {
  const state = { now: 0, probes: 0, logs: [] as string[] };
  const breaker = new LegBreaker({
    host: "primary.example",
    role: "primary",
    cooldownMs: 60_000,
    now: () => state.now,
    log: (l) => state.logs.push(l),
    probe: async () => {
      state.probes++;
      return outcomes.shift() ?? { ok: false, status: 403 };
    },
  });
  return { state, breaker };
}

test("httpStatusOf reads the status from the error or its cause chain", () => {
  assert.equal(httpStatusOf(rejected(403)), 403);
  assert.equal(httpStatusOf({ cause: { cause: rejected(401) } }), 401);
  assert.equal(httpStatusOf(new Error("execution reverted")), null);
  assert.equal(httpStatusOf(null), null);
  assert.equal(httpStatusOf("403"), null);
});

test("only access rejections count: a throttle or a server error must not open the breaker", () => {
  for (const s of [401, 402, 403]) assert.equal(isAccessStatus(s), true, `status ${s}`);
  for (const s of [200, 408, 429, 500, 502, 503]) assert.equal(isAccessStatus(s), false, `status ${s}`);
  assert.equal(isAccessStatus(null), false);
  const { breaker } = harness();
  for (const s of [429, 500, 503, 200]) breaker.observe(s);
  assert.equal(breaker.enter(), "pass");
});

test("redactRpcText cuts every URL down to its origin, so a provider key cannot reach a ledger row", () => {
  const raw =
    "ContractFunctionExecutionError: JSON is not a valid request object.\n\nURL: https://robinhood-mainnet.g.alchemy.com/v2/alch_SECRETKEY123\nRequest body: {\"method\":\"eth_call\"}";
  const out = redactRpcText(raw);
  assert.ok(!out.includes("SECRETKEY123"), "the key must be gone");
  assert.ok(!out.includes("/v2/"), "the path must be gone");
  assert.ok(out.includes("https://robinhood-mainnet.g.alchemy.com/<redacted>"), "the host stays, it is the useful part");
  assert.ok(out.includes("JSON is not a valid request object"), "the message itself survives");
  assert.equal(redactRpcText(new Error("boom at https://x.example/a/b?key=1")), "boom at https://x.example/<redacted>");
  assert.equal(redactRpcText("y".repeat(900), 200).length, 200);
  assert.equal(hostOf("https://robinhood-mainnet.g.alchemy.com/v2/alch_SECRETKEY123"), "robinhood-mainnet.g.alchemy.com");
  assert.equal(hostOf("not a url"), "unparsed-url");
});

test("a rejection opens the breaker; it re-tests with one background probe per cooldown and recovers on its own", async () => {
  const { state, breaker } = harness([{ ok: false, status: 403 }, { ok: false, status: null }, { ok: true, status: 200 }]);
  assert.equal(breaker.enter(), "pass");

  breaker.observe(403);
  assert.equal(breaker.health().state, "skipped");
  assert.equal(breaker.health().lastStatus, 403);
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /REJECTED ACCESS \(HTTP 403\)/);

  assert.equal(breaker.enter(), "skip");
  state.now = 59_000;
  assert.equal(breaker.enter(), "skip");
  assert.equal(state.probes, 0, "no probe inside the cooldown");

  state.now = 61_000;
  assert.equal(breaker.enter(), "skip", "real traffic keeps skipping while the probe runs");
  assert.equal(breaker.enter(), "skip");
  await breaker.settled();
  assert.equal(state.probes, 1, "one probe, however many reads arrived");
  assert.equal(breaker.health().state, "skipped", "still rejected");
  assert.equal(state.logs.length, 1, "the same outage is not announced twice");

  state.now = 122_000;
  breaker.enter();
  await breaker.settled();
  assert.equal(state.probes, 2);
  assert.equal(breaker.health().state, "skipped", "a probe that times out proves nothing; it stays skipped");

  state.now = 183_000;
  breaker.enter();
  await breaker.settled();
  assert.equal(state.probes, 3);
  assert.equal(breaker.health().state, "ok");
  assert.equal(breaker.enter(), "pass");
  assert.equal(state.logs.length, 2);
  assert.match(state.logs[1], /answering again/);
});

test("the boot probe can open and close the breaker before any read happens", () => {
  const { state, breaker } = harness();
  breaker.noteProbe({ ok: false, status: 403 });
  assert.equal(breaker.enter(), "skip");
  breaker.noteProbe({ ok: false, status: null });
  assert.equal(breaker.health().state, "skipped", "an unreachable probe does not clear a rejection");
  breaker.noteProbe({ ok: true, status: 200 });
  assert.equal(breaker.enter(), "pass");
  assert.equal(state.probes, 0);
});

test("inside the fallback transport: a rejecting primary is asked once, then skipped, then used again", async () => {
  let primaryUp = false;
  let primaryCalls = 0;
  let backupCalls = 0;
  const { state, breaker } = harness([{ ok: false, status: 403 }, { ok: true, status: 200 }]);
  const primary = custom(
    {
      async request() {
        primaryCalls++;
        if (!primaryUp) {
          breaker.observe(403); // what the transport's response hook reports
          throw new Error("JSON is not a valid request object.");
        }
        return "0x1";
      },
    },
    { retryCount: 0 },
  );
  const backup = custom(
    {
      async request() {
        backupCalls++;
        return "0x2";
      },
    },
    { retryCount: 0 },
  );
  const client = createPublicClient({ transport: fallback([guardLeg(primary, breaker), backup], { retryCount: 0 }) });
  const ask = () => client.request({ method: "eth_blockNumber" });

  assert.equal(await ask(), "0x2", "the read is served by the fallback");
  assert.equal(primaryCalls, 1);
  for (let i = 0; i < 5; i++) assert.equal(await ask(), "0x2");
  assert.equal(primaryCalls, 1, "the dead endpoint is not touched again");
  assert.equal(backupCalls, 6);

  state.now = 61_000;
  assert.equal(await ask(), "0x2");
  await breaker.settled();
  assert.equal(primaryCalls, 1, "the re-test is the background probe, not a real read");
  assert.equal(state.probes, 1);

  state.now = 122_000;
  primaryUp = true;
  assert.equal(await ask(), "0x2", "this read still skips; the probe it started is what clears the endpoint");
  await breaker.settled();
  assert.equal(await ask(), "0x1", "reads are back on the primary");
  assert.equal(primaryCalls, 2);
});

test("the real http transport: a 403 with a JSON-RPC error body carries NO status on the error, and the breaker still opens", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "ROBINHOOD_MAINNET is not enabled for this app." } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/SECRETKEY`;

    // The trap: this is what the library throws, and there is nothing on it to tell a refusal from a bad request.
    const bare = http(url, { retryCount: 0 })({ retryCount: 0 });
    const thrown = await bare.request({ method: "eth_blockNumber" }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(thrown, "the 403 surfaces as an error");
    assert.equal(httpStatusOf(thrown), null, "the status is gone from the thrown error; only the response hook sees it");

    // The batched client is where the retry tax was paid: four retries per read, forever.
    hits = 0;
    const { breaker } = harness();
    const guarded = guardLeg(
      http(url, { batch: { wait: 5, batchSize: 10 }, retryCount: 4, retryDelay: 1, onFetchResponse: (r) => breaker.observe(r.status) }),
      breaker,
    );
    let backupCalls = 0;
    const backup = custom(
      {
        async request() {
          backupCalls++;
          return "0x2";
        },
      },
      { retryCount: 0 },
    );
    const client = createPublicClient({ transport: fallback([guarded, backup], { retryCount: 0 }) });
    assert.equal(await client.request({ method: "eth_blockNumber" }), "0x2");
    assert.equal(breaker.health().state, "skipped", "one rejected response is enough");
    const afterFirst = hits;
    assert.ok(afterFirst >= 1 && afterFirst <= 5, `the first read may pay the library's retries once (hits ${afterFirst})`);
    for (let i = 0; i < 10; i++) assert.equal(await client.request({ method: "eth_chainId" }), "0x2");
    assert.equal(hits, afterFirst, "no later read touches the rejecting endpoint");
    assert.equal(backupCalls, 11);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rpcHealth names hosts, never URLs", () => {
  const legs = rpcHealth();
  assert.ok(legs.length >= 1);
  for (const leg of legs) {
    assert.ok(!leg.host.includes("/") && !leg.host.includes("http"), `host only, got ${leg.host}`);
    assert.ok(leg.state === "ok" || leg.state === "skipped");
  }
  assert.equal(legs[legs.length - 1].state, "ok", "the last endpoint is never skipped");
});
