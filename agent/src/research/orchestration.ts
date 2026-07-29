import { GatewayClient } from "@openhermit/sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { SEGMENTS, type RwaSegment } from "./segments.js";

/**
 * Provisions the RWA research fleet on an OpenHermit gateway: one agent per
 * market segment (see segments.ts), each running two skills against the
 * Meridian MCP server on two different cadences —
 *
 *   rwa-discover  expensive, broad search for NEW venues, runs weekly-ish
 *   rwa-refresh   cheap, targeted re-check of KNOWN venues, runs often
 *
 * splitting cost from freshness instead of paying discovery-grade cost on
 * every scheduled wake. Agents run without a sandbox (`sandbox: null`) since
 * they only need web search/fetch + MCP tools, no code execution — and are
 * pinned to a cheap model tier, since extraction-style research doesn't need
 * frontier-model reasoning (reserve that for the trading agent itself).
 *
 * This is the durable version of the one-off bootstrap research sweep — a
 * standing swarm that keeps re-collecting, not a single pass. Run it once to
 * set up the fleet and again any time SEGMENTS changes (idempotent: existing
 * agents/schedules are left alone, only missing ones are created).
 *
 * Usage: `npm run provision-fleet` (see package.json). Without
 * GATEWAY_ADMIN_TOKEN set, runs in --dry-run mode and only logs the plan.
 */

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = (id: string) => join(here, "..", "..", "skills", id);

const MCP_SERVER_ID = "meridian";
const DISCOVER_SKILL_ID = "rwa-discover";
const REFRESH_SKILL_ID = "rwa-refresh";

// Cheap-tier model for the research fleet. Override via env if your gateway
// uses different provider/model names. The trading agent itself should stay
// on a stronger model — set that separately, this only targets research agents.
const RESEARCH_MODEL = {
  provider: process.env.RWA_FLEET_MODEL_PROVIDER ?? "anthropic",
  model: process.env.RWA_FLEET_MODEL_ID ?? "claude-haiku-4-5",
};

function agentIdFor(segment: RwaSegment): string {
  return `rwa-research-${segment.key}`;
}

function segmentInstruction(segment: RwaSegment, agentId: string): string {
  const cadence = segment.refreshCadenceCron
    ? `discover on "${segment.discoverCadenceCron}" (cron), refresh known venues on "${segment.refreshCadenceCron}"`
    : `discover/refresh combined on "${segment.discoverCadenceCron}" (cron)`;
  // Deliberately NO swarm learning in this instruction. These agents hold the
  // operator MCP token (research-write), and this text carries the quality bar
  // and the submit rule. Takeaway sentences are shaped by conversations that a
  // user's agent takes part in, so letting them into the same instruction would
  // put model-authored, indirectly user-influenced text alongside the rules that
  // gate a privileged tool. The swarm writes them to their own instruction slot
  // instead (see swarm/exchange.ts applyLearning), where they cannot displace or
  // precede anything that matters.
  return (
    `Your assigned RWA segment: "${segment.title}".\n` +
    `Known anchor venues (already in our universe — do NOT resubmit these as new; only add genuinely additional venues): ${segment.anchors}.\n` +
    `Schedule: ${cadence}. Use the rwa-discover skill for discovery runs and the rwa-refresh skill for ` +
    `refresh runs — they have very different cost profiles, follow the one your current run is for.\n` +
    `QUALITY BAR (enforced): for EVERY venue you submit you MUST include (a) "sources": at least one real URL you actually found it on, and (b) "confidence": "high" | "medium" | "low" reflecting how well-sourced it is. Never submit a venue you cannot cite a source for, and never invent TVL or dates — omit a field rather than guess.\n` +
    `Submit findings via mcp__meridian__meridian_submit_research with submittedBy set to "${agentId}".`
  );
}

async function provisionDryRun(): Promise<void> {
  console.log("[fleet] GATEWAY_ADMIN_TOKEN not set — dry run, no gateway calls will be made.\n");
  console.log(`[fleet] would register MCP server "${MCP_SERVER_ID}" -> ${config.publicMcpUrl}`);
  console.log(`[fleet] would register skills "${DISCOVER_SKILL_ID}" and "${REFRESH_SKILL_ID}"`);
  for (const segment of SEGMENTS) {
    const agentId = agentIdFor(segment);
    const schedules = segment.refreshCadenceCron
      ? `discover "${segment.discoverCadenceCron}" + refresh "${segment.refreshCadenceCron}"`
      : `discover "${segment.discoverCadenceCron}" only`;
    console.log(
      `[fleet] would ensure agent "${agentId}" (sandbox: none, model: ${RESEARCH_MODEL.provider}/${RESEARCH_MODEL.model}): ` +
        `enable mcp+skills, set segment instruction, schedule ${schedules}`,
    );
  }
  console.log(`\n[fleet] ${SEGMENTS.length} segment agents planned. Set GATEWAY_ADMIN_TOKEN and re-run to apply.`);
}

export async function provisionFleet(): Promise<void> {
  if (!config.gatewayAdminToken) {
    await provisionDryRun();
    return;
  }

  const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });

  console.log(`[fleet] registering MCP server "${MCP_SERVER_ID}" -> ${config.publicMcpUrl}`);
  await gw.registerMcpServer({
    id: MCP_SERVER_ID,
    name: "Meridian",
    description: "Cross-chain RWA DEX tools: market data, bridge routing, x402 settlement, research universe",
    url: config.publicMcpUrl,
    headers: config.mcpToken ? { Authorization: `Bearer ${config.mcpToken}` } : undefined,
  });

  console.log(`[fleet] registering skill "${DISCOVER_SKILL_ID}" (expensive, broad search)`);
  await gw.registerSkill({
    id: DISCOVER_SKILL_ID,
    name: "RWA segment discovery",
    description: "Broad search to find new venues in an assigned RWA market segment. Expensive — runs rarely.",
    path: skillPath(DISCOVER_SKILL_ID),
  });

  console.log(`[fleet] registering skill "${REFRESH_SKILL_ID}" (cheap, targeted)`);
  await gw.registerSkill({
    id: REFRESH_SKILL_ID,
    name: "RWA segment refresh",
    description: "Cheap, targeted re-check of already-known venues in an assigned RWA segment. Runs often.",
    path: skillPath(REFRESH_SKILL_ID),
  });

  const existingAgents = new Set((await gw.listAgents()).map((a) => a.agentId));

  for (const segment of SEGMENTS) {
    const agentId = agentIdFor(segment);
    try {
      if (!existingAgents.has(agentId)) {
        console.log(`[fleet] creating agent "${agentId}" (no sandbox — web search/fetch + MCP only)`);
        await gw.createAgent({ agentId, name: `RWA Research — ${segment.title}`, sandbox: null });
      }

      await gw.enableMcpServer(MCP_SERVER_ID, agentId);
      await gw.enableSkill(DISCOVER_SKILL_ID, agentId);
      await gw.enableSkill(REFRESH_SKILL_ID, agentId);
      await gw.setInstruction(agentId, "segment", segmentInstruction(segment, agentId));
      await gw.putAgentConfig(agentId, { model: RESEARCH_MODEL });

      await gw.createSchedule(agentId, {
        type: "cron",
        id: `${agentId}-discover`,
        cronExpression: segment.discoverCadenceCron,
        prompt: "Run a discovery sweep now per the rwa-discover skill and submit any new venues.",
      });

      if (segment.refreshCadenceCron) {
        await gw.createSchedule(agentId, {
          type: "cron",
          id: `${agentId}-refresh`,
          cronExpression: segment.refreshCadenceCron,
          prompt: "Run a refresh pass now per the rwa-refresh skill — only known venues, no broad search.",
        });
      }

      const scheduleSummary = segment.refreshCadenceCron
        ? `discover ${segment.discoverCadenceCron} / refresh ${segment.refreshCadenceCron}`
        : `discover ${segment.discoverCadenceCron}`;
      console.log(`[fleet] ✓ ${agentId} provisioned (${scheduleSummary})`);
    } catch (err) {
      console.error(`[fleet] ✗ ${agentId} failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n[fleet] done — ${SEGMENTS.length} segment agents targeted.`);
}

// ---- On-demand provisioning (driven from the backend, which can reach the
// gateway on the internal network). Same work as provisionFleet but (a) takes a
// SUBSET of segments so we can pilot a few and watch cost, (b) re-registers BOTH
// MCP servers at the current publicMcpUrl so a stale 127.0.0.1 registration gets
// corrected, (c) uses get-merge-put for agent config (a partial config fails the
// gateway's validation on workspace_root/memory/max_tokens), and (d) pins the
// OpenRouter model tier that the gateway actually has a key for.

const owner = () => process.env.MERIDIAN_FLEET_OWNER_USER_ID || undefined;

function researchModel(): { provider: string; model: string } {
  return {
    provider: process.env.RWA_FLEET_MODEL_PROVIDER ?? "openrouter",
    model: process.env.RWA_FLEET_MODEL_ID ?? "anthropic/claude-haiku-4.5",
  };
}

export interface ProvisionResult {
  publicMcpUrl: string;
  registered: string[];
  provisioned: string[];
  skipped: string[];
  errors: Record<string, string>;
  /** false when the agents were created without any recurring research cadence */
  scheduled: boolean;
}

/**
 * Provision a chosen set of research-segment agents on our gateway.
 *
 * `schedules` is the money switch, and it is off by default on purpose. Creating
 * an agent costs nothing and it can hold conversations for the price of the
 * conversations. The cron schedules are what spend continuously: across all
 * twelve segments they add up to roughly 22 wakes a day, about 5.6 of them
 * broad discovery sweeps that each run open-ended web search. So the agents come
 * online first, and research cadence is a second, deliberate decision, taken per
 * segment when the data is actually wanted.
 */
export async function provisionResearchFleet(
  segmentKeys: string[],
  opts: { schedules?: boolean } = {},
): Promise<ProvisionResult> {
  const withSchedules = opts.schedules === true;
  if (!config.gatewayAdminToken || !config.gatewayUrl) throw new Error("gateway_unconfigured");
  const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });

  // Re-register both MCP servers at the CURRENT url (upsert updates a stale one).
  // "meridian" carries the operator bearer (research fleet needs submit_research);
  // "meridian-public" carries none (user chat agents can never reach operator tools).
  const registered: string[] = [];
  await gw.registerMcpServer({
    id: MCP_SERVER_ID,
    name: "Meridian",
    description: "RWA market data, universe, routing, and research submit (operator-gated).",
    url: config.publicMcpUrl,
    headers: config.mcpToken ? { Authorization: `Bearer ${config.mcpToken}` } : undefined,
  });
  registered.push(`${MCP_SERVER_ID} -> ${config.publicMcpUrl}`);
  await gw.registerMcpServer({
    id: "meridian-public",
    name: "Meridian (public)",
    description: "Meridian market data and signal tools. No operator credentials.",
    url: config.publicMcpUrl,
  });
  registered.push(`meridian-public -> ${config.publicMcpUrl}`);

  // Skills are a nice-to-have (they encode discovery methodology) but live in
  // the backend repo, not the gateway image, so filesystem registration can
  // ENOENT on the gateway. Non-fatal: agents still run off their instruction +
  // web search + MCP tools. Best-effort register.
  try {
    await gw.registerSkill({ id: DISCOVER_SKILL_ID, name: "RWA segment discovery", description: "Broad search to find new venues in an assigned RWA market segment. Expensive.", path: skillPath(DISCOVER_SKILL_ID) });
    await gw.registerSkill({ id: REFRESH_SKILL_ID, name: "RWA segment refresh", description: "Cheap, targeted re-check of already-known venues.", path: skillPath(REFRESH_SKILL_ID) });
  } catch { /* skills unavailable on gateway fs — agents run without them */ }

  const model = researchModel();
  const existing = new Set((await gw.listAgents()).map((a) => a.agentId));
  const provisioned: string[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};

  for (const key of segmentKeys) {
    const segment = SEGMENTS.find((s) => s.key === key);
    if (!segment) { skipped.push(key); continue; }
    const agentId = agentIdFor(segment);
    try {
      if (!existing.has(agentId)) {
        await gw.createAgent({ agentId, name: `RWA Research — ${segment.title}`, sandbox: null, ownerUserId: owner() });
      }
      await gw.enableMcpServer(MCP_SERVER_ID, agentId);
      try {
        await gw.enableSkill(DISCOVER_SKILL_ID, agentId);
        await gw.enableSkill(REFRESH_SKILL_ID, agentId);
      } catch { /* skills not on gateway fs — non-fatal */ }
      await gw.setInstruction(agentId, "segment", segmentInstruction(segment, agentId));
      // get-merge-put: never send a partial config (fails gateway validation).
      // Also switch web search off the free "defuddle" default (it 429s under a
      // discovery sweep) onto a real agent-search provider — Exa by default,
      // which needs EXA_API_KEY set on the gateway.
      const cur = (await gw.getAgentConfig(agentId)) as Record<string, unknown>;
      const curModel = (cur.model ?? {}) as Record<string, unknown>;
      const curWeb = (cur.web ?? {}) as Record<string, unknown>;
      await gw.putAgentConfig(agentId, {
        ...cur,
        web: { ...curWeb, provider: process.env.RWA_FLEET_WEB_PROVIDER ?? "exa" },
        model: { ...curModel, ...model, max_tokens: typeof curModel.max_tokens === "number" ? curModel.max_tokens : 8192 },
      });
      // Schedules are created once; on re-provision they already exist, so a
      // duplicate insert is expected and non-fatal.
      const createdBy = owner();
      if (withSchedules) try {
        await gw.createSchedule(agentId, {
          type: "cron",
          id: `${agentId}-discover`,
          cronExpression: segment.discoverCadenceCron,
          prompt: "Run a discovery sweep now per the rwa-discover skill and submit any new venues via meridian_submit_research.",
          ...(createdBy ? { createdBy } : {}),
        } as Parameters<GatewayClient["createSchedule"]>[1]);
        if (segment.refreshCadenceCron) {
          await gw.createSchedule(agentId, {
            type: "cron",
            id: `${agentId}-refresh`,
            cronExpression: segment.refreshCadenceCron,
            prompt: "Run a refresh pass now per the rwa-refresh skill — only known venues, no broad search.",
            ...(createdBy ? { createdBy } : {}),
          } as Parameters<GatewayClient["createSchedule"]>[1]);
        }
      } catch { /* schedule already exists — non-fatal on re-provision */ }
      provisioned.push(agentId);
    } catch (err) {
      errors[agentId] = err instanceof Error ? err.message : String(err);
    }
  }

  return { publicMcpUrl: config.publicMcpUrl, registered, provisioned, skipped, errors, scheduled: withSchedules };
}

/** Manually wake one research agent to run a discovery sweep now (proves the pipe). */
export async function triggerResearchRun(agentId: string): Promise<{ text: string; toolCalls: number }> {
  if (!config.gatewayAdminToken || !config.gatewayUrl) throw new Error("gateway_unconfigured");
  const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });
  const sessionId = `discover-${agentId}-${Date.now()}`;
  try {
    await gw.agent(agentId).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } });
  } catch {
    /* already open */
  }
  const resp = await gw.agent(agentId).postMessageSync(
    sessionId,
    { text: "Run a discovery sweep now per the rwa-discover skill: search the web for venues in your assigned segment and submit every new one via meridian_submit_research with submittedBy set to your agent id. Report how many you submitted." },
    { timeout: 240_000 },
  );
  return { text: resp.text ?? "", toolCalls: (resp.toolCalls ?? []).length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  provisionFleet().catch((err) => {
    console.error("[fleet] provisioning crashed:", err);
    process.exit(1);
  });
}
