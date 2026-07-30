// The Meridian CLI: one typed line in, lines of text out.
//
// Customising an agent used to live in a modal behind a button inside the chat
// panel: a form you had to find, open, fill and save. Almost nobody finds a
// modal, and a form cannot be taught, quoted, or chained. So the same
// capabilities are commands here, next to the conversation, where they are
// discoverable by typing /help and where the agent itself can tell you the
// command to run.
//
// WHY A PURE ROUTER. Every command resolves to a plain object, and nothing in
// this file reads the network, the clock, or a request. The route wires it to
// the wallet session; this module can be unit-tested by calling it. That split
// matters because a command surface is a security boundary: it is user text
// deciding which capability runs.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never writes settings itself. Every
// mutation is expressed as an INTENT that the caller applies through
// sanitizeSettings, the same validator the settings route uses. A command
// surface that hand-rolls its own validation is how a field that rejects
// newlines in one place accepts them in another, and these values are
// interpolated into the agent's persona prompt.
import { RISK_LEVELS, STYLES, FOCUS_AREAS, type AgentSettings } from "../deploy/agentSettings.js";

/** What a command wants done. The route applies it; this module only decides. */
export type CliEffect =
  | { kind: "none" }
  /** Apply this patch through sanitizeSettings, then report what changed. */
  | { kind: "settings"; patch: Record<string, unknown> }
  /** Hand the line to the house desk console (read-only market commands). */
  | { kind: "desk"; command: string }
  /** Send this to the user's own agent as a chat turn. */
  | { kind: "chat"; text: string }
  /** Read something the router cannot: balance, roster, history. */
  | { kind: "read"; what: "credits" | "settings" | "swarm" }
  /** Client-side only: wipe the visible transcript. */
  | { kind: "clear" };

export interface CliResult {
  /** Lines to print. Empty when the effect produces the output instead. */
  lines: string[];
  effect: CliEffect;
  /** True when the line was not understood, so the UI can style it as an error. */
  error?: boolean;
}

const ok = (lines: string[], effect: CliEffect = { kind: "none" }): CliResult => ({ lines, effect });
const err = (lines: string[]): CliResult => ({ lines, effect: { kind: "none" }, error: true });

/** Read-only house-desk commands that already exist in console.ts. Passed
 *  through rather than reimplemented, so the CLI and the desk can never drift. */
const DESK = new Set([
  "status", "pnl", "position", "scan", "proof", "why",
  "trades", "basis", "lp", "universe", "tools", "wallet",
]);

const HELP = [
  "meridian cli. type a message to talk to your agent, or use a command.",
  "",
  "  your agent",
  "    /whoami            what your agent is set to right now",
  "    /name <name>       rename it",
  "    /risk <level>      conservative | balanced | aggressive",
  "    /style <style>     concise | balanced | deep",
  "    /focus <a,b>       market-making, yield, directional, research",
  "    /goal <text>       what you want it working toward",
  "    /swarm on|off      let it speak in the public agent feed",
  "    /reset <field>     clear one setting back to default",
  "",
  "  the desk (live market, read only)",
  "    /status /pnl /position /proof /why /trades",
  "    /basis /lp /scan /universe /tools /wallet",
  "",
  "  session",
  "    /credits           how many messages you have left",
  "    /clear             clear this transcript",
  "    /help              this",
  "",
  "anything that is not a command is a message to your agent.",
];

const list = (xs: readonly string[]) => xs.join(" | ");

/**
 * Route one line.
 *
 * `settings` is the agent's CURRENT values, needed because some commands report
 * or toggle relative to them. Never mutated here.
 */
export function routeCli(raw: string, settings: AgentSettings): CliResult {
  const line = (raw ?? "").trim();
  if (!line) return ok([]);

  // Not a command: it is something to say to the agent. This is the common case
  // and it is checked first so a message beginning with a slash-like character
  // (a fraction, a path) is not mistaken for a command.
  if (!line.startsWith("/")) return ok([], { kind: "chat", text: line });

  const [head, ...rest] = line.slice(1).split(/\s+/);
  const cmd = (head ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "":
      return err(["type /help to see what you can do."]);

    case "help":
    case "?":
      return ok(HELP);

    case "clear":
      return ok([], { kind: "clear" });

    case "credits":
      return ok([], { kind: "read", what: "credits" });

    case "whoami":
    case "settings":
      return ok([], { kind: "read", what: "settings" });

    case "name": {
      if (!arg) return err(["usage: /name <name>", `currently: ${settings.name ?? "Merd (default)"}`]);
      return ok([], { kind: "settings", patch: { name: arg } });
    }

    case "risk": {
      const v = arg.toLowerCase();
      if (!v) return err([`usage: /risk <${list(RISK_LEVELS)}>`, `currently: ${settings.riskAppetite ?? "balanced (default)"}`]);
      if (!RISK_LEVELS.includes(v as never)) return err([`"${arg}" is not a risk level. pick one of: ${list(RISK_LEVELS)}`]);
      return ok([], { kind: "settings", patch: { riskAppetite: v } });
    }

    case "style": {
      const v = arg.toLowerCase();
      if (!v) return err([`usage: /style <${list(STYLES)}>`, `currently: ${settings.style ?? "balanced (default)"}`]);
      if (!STYLES.includes(v as never)) return err([`"${arg}" is not a style. pick one of: ${list(STYLES)}`]);
      return ok([], { kind: "settings", patch: { style: v } });
    }

    case "focus": {
      if (!arg) {
        return err([
          `usage: /focus <${list(FOCUS_AREAS)}>  (comma separated, one or more)`,
          `currently: ${settings.focus?.length ? settings.focus.join(", ") : "all areas (default)"}`,
        ]);
      }
      // Commas OR spaces, because a person typing a list will use either and
      // being strict about the separator is the kind of thing that makes a CLI
      // feel hostile rather than precise.
      const wanted = arg.toLowerCase().split(/[,\s]+/).filter(Boolean);
      const bad = wanted.filter((w) => !FOCUS_AREAS.includes(w as never));
      if (bad.length) return err([`not a focus area: ${bad.join(", ")}`, `pick from: ${list(FOCUS_AREAS)}`]);
      return ok([], { kind: "settings", patch: { focus: [...new Set(wanted)] } });
    }

    case "goal": {
      if (!arg) return err(["usage: /goal <what you want it working toward>", `currently: ${settings.goal ?? "not set"}`]);
      return ok([], { kind: "settings", patch: { goal: arg } });
    }

    case "swarm": {
      const v = arg.toLowerCase();
      if (v !== "on" && v !== "off") {
        const now = settings.joinSwarm === true ? "on" : "off";
        return err(["usage: /swarm on|off", `currently: ${now}`, "when on, your agent can speak in the public feed under the name you gave it."]);
      }
      return ok([], { kind: "settings", patch: { joinSwarm: v === "on" } });
    }

    case "reset": {
      const f = arg.toLowerCase();
      // Only the fields a person can set. "name" resets to the default rather
      // than to empty, which is why it is expressed as a value not a deletion.
      const fields: Record<string, Record<string, unknown>> = {
        name: { name: "" },
        goal: { goal: "" },
        risk: { riskAppetite: "balanced" },
        style: { style: "balanced" },
        focus: { focus: [...FOCUS_AREAS] },
        swarm: { joinSwarm: false },
      };
      if (!f || !(f in fields)) return err([`usage: /reset <${Object.keys(fields).join(" | ")}>`]);
      return ok([], { kind: "settings", patch: fields[f] });
    }

    default:
      if (DESK.has(cmd)) return ok([], { kind: "desk", command: cmd });
      return err([`"/${cmd}" is not a command. /help lists them.`, ...suggest(cmd)]);
  }
}

/**
 * One suggestion for a near-miss, by edit distance on a small fixed vocabulary.
 * A CLI that answers a typo with nothing but "unknown command" makes people stop
 * exploring, and exploring is the whole point of putting this in front of them.
 */
function suggest(cmd: string): string[] {
  const vocab = ["help", "whoami", "name", "risk", "style", "focus", "goal", "swarm", "reset", "credits", "clear", ...DESK];
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of vocab) {
    const d = distance(cmd, v);
    if (d < bestD) { bestD = d; best = v; }
  }
  // Only offer it when it is actually close. A wrong suggestion is worse than
  // none: it sends someone off to try a command they never meant.
  return best && bestD <= 2 ? [`did you mean /${best}?`] : [];
}

function distance(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
}

/** Human summary of an agent's current configuration, for /whoami. */
export function describeSettings(s: AgentSettings): string[] {
  return [
    `name    ${s.name ?? "Merd (default)"}`,
    `risk    ${s.riskAppetite ?? "balanced (default)"}`,
    `style   ${s.style ?? "balanced (default)"}`,
    `focus   ${s.focus?.length ? s.focus.join(", ") : "all areas (default)"}`,
    `goal    ${s.goal ?? "not set"}`,
    `swarm   ${s.joinSwarm === true ? "on, your agent may speak publicly" : "off"}`,
  ];
}
