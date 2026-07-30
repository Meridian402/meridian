import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type McpAudience } from "../src/mcp/server.js";

/**
 * The public tool list is a COST control, never a gate.
 *
 * Tool definitions are re-sent on every model turn, so a user chat agent
 * (connecting through the credential-free "meridian-public" registration) is
 * not served definitions for tools it can never pass the token check on. The
 * checks themselves live in index.ts (EXECUTE_TOOLS -> executeAuthorized,
 * OPERATOR_ONLY_TOOLS -> authorized) and are unchanged; this suite only pins
 * two things: the default is still the full surface, and the public surface
 * loses exactly the four unusable tools and nothing else.
 */
const HIDDEN_FROM_PUBLIC = [
  "meridian_bridge_execute",
  "meridian_index_execute",
  "meridian_index_yield_execute",
  "meridian_submit_research",
];

async function toolNames(audience?: McpAudience): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = audience ? buildServer({ audience }) : buildServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "audience-test", version: "0.0.1" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name).sort();
}

test("the default build is unchanged: every tool, as before", async () => {
  const names = await toolNames();
  const operator = await toolNames("operator");
  assert.deepEqual(names, operator);
  for (const hidden of HIDDEN_FROM_PUBLIC) {
    assert.ok(names.includes(hidden), `default build lost ${hidden}`);
  }
});

test("the public build drops exactly the tools a credential-free caller cannot call", async () => {
  const operator = await toolNames("operator");
  const publicNames = await toolNames("public");
  assert.deepEqual(
    operator.filter((n) => !publicNames.includes(n)).sort(),
    [...HIDDEN_FROM_PUBLIC].sort(),
  );
  // Nothing may appear ONLY on the public list: it is a strict subset.
  assert.deepEqual(publicNames.filter((n) => !operator.includes(n)), []);
});

test("the launch tool stays on the public list, because that is who it is for", async () => {
  const publicNames = await toolNames("public");
  assert.ok(publicNames.includes("meridian_launch_token_pons"));
  // Flap was removed on purpose. Asserting its ABSENCE keeps it removed: a
  // re-add would otherwise reappear silently on the credential-free surface,
  // which is the exact audience it was worst for.
  assert.ok(!publicNames.includes("meridian_launch_token"), "the Flap tool must not come back");
});
