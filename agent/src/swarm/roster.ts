// Who is allowed to speak in the public agent-to-agent feed.
//
// Two classes, and the difference is consent. House agents are ours: the
// per-segment research fleet (deterministic ids from SEGMENTS, see
// research/orchestration.ts) plus, when the env names one, our main agent. A
// USER's agent speaks for a real person, so it is eligible only when that
// wallet set joinSwarm itself through its own settings route. There is no
// other way in: absence of the flag is a no, and nothing here infers consent
// from activity, balance, or anything else the user did not explicitly choose.
import { createHash } from "node:crypto";
import { GatewayClient } from "@openhermit/sdk";
import { config } from "../config.js";
import { SEGMENTS } from "../research/segments.js";
import { allAgentSettings, type AgentSettings } from "../deploy/agentSettings.js";
import { agentIdForWallet, agentDisplayName } from "../deploy/myAgent.js";

export interface Participant {
  kind: "house" | "user";
  /** the gateway agent id we actually address */
  id: string;
  /**
   * The identity that goes in the PUBLIC feed. For a house agent it is just the
   * id. For a user's agent it must never be the gateway id, because that id is
   * the wallet: mrdn-u-<40 hex> is the address with a prefix. Publishing it
   * would turn every opted-in conversation into a permanent link between a
   * person's wallet and everything their agent said, which is not what anyone
   * consented to by ticking a box that says their agent's messages are public.
   */
  publicId: string;
  displayName: string;
  /** present for user agents only: the wallet whose agent this is */
  address?: string;
  /** what this agent's beat is, given to the OTHER agent so it knows who it is
   *  talking to. Empty for a user agent: we do not describe someone's agent for them. */
  expertise?: string;
}

/**
 * A short desk label from the segment's stable key ("equities" -> "Equities
 * Desk"). The keys are the segment titles already reduced to their subject;
 * the titles themselves are long prose ("Tokenized public equities / stocks")
 * and read badly as a speaker name. The full title rides along as expertise.
 */
function deskName(key: string): string {
  const words = key
    .split("-")
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return `${words.join(" ")} Desk`;
}

/** The research fleet: one house participant per segment, always eligible. */
export function researchParticipants(): Participant[] {
  return SEGMENTS.map((s) => ({
    kind: "house" as const,
    id: `rwa-research-${s.key}`,
    publicId: `rwa-research-${s.key}`,
    displayName: deskName(s.key),
    expertise: s.title,
  }));
}

/**
 * Our main house agent, if this deployment names one. Deliberately env-driven:
 * the research fleet's ids are derived from SEGMENTS and provably exist, while
 * the main agent's id is whatever the operator provisioned, so guessing it
 * would put a speaker in the roster that the gateway would 404 on.
 */
export function mainHouseParticipant(): Participant | null {
  const id = (process.env.MERIDIAN_HOUSE_AGENT_ID ?? "").trim();
  if (!id) return null;
  return {
    kind: "house",
    id,
    publicId: id,
    displayName: (process.env.MERIDIAN_HOUSE_AGENT_NAME ?? "House Desk").trim() || "House Desk",
    expertise: "Meridian's own market-making desk: live liquidity provision and the house book",
  };
}

export function houseParticipants(): Participant[] {
  const main = mainHouseParticipant();
  return [...(main ? [main] : []), ...researchParticipants()];
}

/** The one consent rule, isolated so it is testable and impossible to fudge. */
export function userOptedIn(settings: AgentSettings | undefined): boolean {
  return settings?.joinSwarm === true;
}

/**
 * The public handle for a wallet's agent. A truncated hash, so the feed can
 * attribute a line to a stable speaker and carry its takeaways forward without
 * the address ever leaving the backend. Deterministic, so it survives restarts
 * and stays stable across exchanges.
 */
export function publicIdForWallet(address: string): string {
  return `agent-${createHash("sha256").update(`meridian.swarm.speaker:${address.toLowerCase()}`).digest("hex").slice(0, 12)}`;
}

/** Every user agent whose wallet opted in, in a stable order. */
export function userParticipants(): Participant[] {
  return allAgentSettings()
    .filter((r) => userOptedIn(r.settings))
    .map((r) => ({
      kind: "user" as const,
      id: agentIdForWallet(r.address),
      publicId: publicIdForWallet(r.address),
      displayName: agentDisplayName(r.address),
      address: r.address,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The public ids of everyone currently opted in. Turning the toggle off has to
 * mean something, so the feed uses this to stop serving a user's past lines too,
 * not just to skip them in future pairings.
 */
export function optedInPublicIds(): Set<string> {
  return new Set(userParticipants().map((p) => p.publicId));
}

/**
 * Everyone eligible BY POLICY. This is the intent, not the reality: an id here
 * has passed the consent and ownership rules but may not exist on the gateway.
 * Use listLiveParticipants for anything that actually speaks.
 */
export function listParticipants(): Participant[] {
  return [...houseParticipants(), ...userParticipants()];
}

// --- who actually exists -----------------------------------------------------
//
// The roster above is derived from config and settings, and neither knows what
// the gateway is really hosting. Two failures follow from trusting it. An agent
// we never provisioned makes every exchange it is picked for die at the first
// turn, which is how a swarm ends up permanently empty while looking configured.
// And this gateway hosts agents belonging to entirely different projects, none
// of which have any business speaking in Meridian's public feed.
//
// So the live roster is an INTERSECTION: policy-eligible, and present on the
// gateway, and Meridian's to speak for.

/** Fleet agent ids look like mrdn-fleet-<hash>-<mandate>. */
const FLEET_RE = /^mrdn-fleet-[a-z0-9]+-(.+)$/;

const MANDATE_EXPERTISE: Record<string, string> = {
  "market-maker": "providing liquidity in tokenized-equity pools and earning the fee on real flow",
  carry: "parking capital where it earns a measured on-chain rate, and knowing when it stops being worth it",
  signals: "basis and cross-venue signals, traded only behind cost-aware bars",
  momentum: "momentum and trend, and the discipline of standing down when the edge is not there",
};

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Turn a live gateway agent id into a house participant, or null when the agent
 * is not ours to speak for. The allowlist is by id SHAPE, so adding a research
 * segment or provisioning another fleet brings that agent in automatically,
 * while an unrelated project's agent on the same gateway can never qualify.
 */
export function houseParticipantFor(agentId: string): Participant | null {
  const main = mainHouseParticipant();
  if (main && agentId === main.id) return main;

  // The house desk itself. Naming it here rather than only via env is safe now
  // that the roster is intersected with the gateway's real agent list: if this
  // deployment has no agent called "merd", it simply never appears. Without it
  // the one agent the whole site is about would be missing from the swarm.
  if (agentId === "merd") {
    return {
      kind: "house",
      id: agentId,
      publicId: agentId,
      displayName: "Merd",
      expertise: "Meridian's own market-making desk: live liquidity provision in tokenized-equity pools, and the house book",
    };
  }

  const segment = SEGMENTS.find((s) => agentId === `rwa-research-${s.key}`);
  if (segment) return { kind: "house", id: agentId, publicId: agentId, displayName: deskName(segment.key), expertise: segment.title };

  const fleet = FLEET_RE.exec(agentId);
  if (fleet) {
    const mandate = fleet[1];
    return {
      kind: "house",
      id: agentId,
      publicId: agentId,
      displayName: `${titleCase(mandate)} Desk`,
      expertise: MANDATE_EXPERTISE[mandate] ?? `Meridian's ${mandate.replace(/-/g, " ")} mandate`,
    };
  }
  return null;
}

// The gateway is asked at most once a minute. Long enough that a rotation does
// not hammer it, short enough that provisioning a new agent shows up while you
// are still watching for it.
const LIVE_TTL_MS = 60_000;
let liveCache: { at: number; ids: Set<string> } | null = null;

/** Agent ids the gateway is actually hosting. Empty set when it cannot be reached. */
export async function liveAgentIds(force = false): Promise<Set<string>> {
  if (!force && liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.ids;
  if (!config.gatewayAdminToken || !config.gatewayUrl) return new Set();
  try {
    const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });
    const ids = new Set((await gw.listAgents()).map((a) => a.agentId));
    liveCache = { at: Date.now(), ids };
    return ids;
  } catch (err) {
    console.error("[swarm] could not list gateway agents:", err instanceof Error ? err.message : err);
    // Deliberately not cached: a gateway blip should not blank the roster for a
    // full minute, and returning empty just means no exchange runs this tick.
    return liveCache?.ids ?? new Set();
  }
}

/**
 * Everyone who can actually speak right now. House agents are whatever Meridian
 * agents the gateway is hosting; user agents must ALSO have opted in, so the
 * consent rule still gates them even though they are provisioned.
 */
export async function listLiveParticipants(): Promise<Participant[]> {
  const live = await liveAgentIds();
  if (!live.size) return [];
  const house: Participant[] = [];
  for (const id of [...live].sort()) {
    const p = houseParticipantFor(id);
    if (p) house.push(p);
  }
  const users = userParticipants().filter((p) => live.has(p.id));
  return disambiguate([...house, ...users]);
}

/**
 * Make every speaker's name unique before it reaches a published feed.
 *
 * Fleet display names come from the MANDATE, so two agents running the same
 * mandate both render as "Market Maker Desk" (production has exactly that
 * today). Two identically named speakers in a transcript does not read as two
 * desks, it reads as a bug, and it also makes the takeaways impossible to
 * attribute. Only collisions get a suffix, so the common case of one desk per
 * mandate stays clean, and the suffix is the fleet's own short id so the same
 * agent always carries the same label rather than one that shifts with roster
 * order.
 */
function disambiguate(list: Participant[]): Participant[] {
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.displayName, (counts.get(p.displayName) ?? 0) + 1);
  return list.map((p) => {
    if ((counts.get(p.displayName) ?? 0) < 2) return p;
    const tag = /^mrdn-fleet-([a-z0-9]+)-/.exec(p.id)?.[1];
    return tag ? { ...p, displayName: `${p.displayName} ${tag.toUpperCase()}` } : p;
  });
}

/**
 * A speaker as it may be shown OUTSIDE the backend.
 *
 * Deliberately a different type from Participant. Participant carries the
 * gateway id and, for a user, the wallet itself; this carries neither. The
 * status route used to project Participant's fields by hand and reached for
 * `id`, which for a user's agent is `mrdn-u-<40 hex>`: the address with a
 * prefix and nothing else. That served every opted-in wallet from an
 * unauthenticated, `*`-CORS endpoint, tied to the name its owner chose and to
 * everything that agent had ever said in the feed. Opting in is supposed to
 * publish an agent's opinions, not its owner.
 *
 * Structural, not a patch: nothing here hands out a Participant any more, so
 * the next caller cannot repeat the mistake by picking the obvious field.
 */
export interface PublicSpeaker {
  id: string;
  name: string;
  kind: "house" | "user";
}

/**
 * Redact a raw gateway id for public display. House ids are already public (they
 * name a desk, not a person); a user id is reduced to the same hash the feed
 * uses, so a speaker stays recognisable across both surfaces.
 */
export function publicIdFor(agentId: string): string {
  const wallet = /^mrdn-u-([0-9a-fA-F]{40})$/.exec(agentId);
  return wallet ? publicIdForWallet(`0x${wallet[1]}`) : agentId;
}

/**
 * What anyone needs to see when the feed is empty: who is really there, and who
 * is eligible but missing. Missing means configured or opted in but not
 * provisioned on the gateway, which is the usual reason nothing is happening.
 *
 * A missing user agent is named by hash like any other, so this cannot be used
 * to enumerate wallets. Repairing one is an admin route's job, and that route
 * already authenticates.
 */
export async function rosterHealth(): Promise<{
  live: PublicSpeaker[];
  missing: { id: string; kind: "house" | "user" }[];
  gatewayReachable: boolean;
}> {
  const ids = await liveAgentIds();
  const live = await listLiveParticipants();
  const liveIds = new Set(live.map((p) => p.id));
  const missing = listParticipants()
    .filter((p) => !liveIds.has(p.id))
    .map((p) => ({ id: p.publicId, kind: p.kind }));
  return {
    live: live.map((p) => ({ id: p.publicId, name: p.displayName, kind: p.kind })),
    missing,
    gatewayReachable: ids.size > 0,
  };
}
