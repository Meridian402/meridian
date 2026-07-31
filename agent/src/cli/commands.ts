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
  /** Read something the router cannot: balance, prices, roster, settings. */
  | { kind: "read"; what: "credits" | "settings" | "swarm" | "packs" }
  /** Start a purchase. The CLI cannot sign, so the client runs the wallet flow. */
  | { kind: "buy"; pack: string }
  /** Client-side only: wipe the visible transcript. */
  | { kind: "clear" };

export interface CliResult {
  /** Lines to print. Empty when the effect produces the output instead. */
  lines: string[];
  effect: CliEffect;
  /** True when the line was not understood, so the UI can style it as an error. */
  error?: boolean;
  /**
   * What to offer as one-tap next steps.
   *
   * Structured rather than left inside the printed text, because the whole
   * point is that the client can RUN these. Printing "try: /status" and making
   * somebody retype it is the clunkiness: every step of the tour, every near
   * miss on a typo, and every "here is what you can do next" ended in the
   * person copying a string by hand. An entry is a literal line to submit, so
   * it can be a command or an ordinary message, and the client does not have to
   * know which.
   */
  suggest?: string[];
}

const ok = (lines: string[], effect: CliEffect = { kind: "none" }, suggest?: string[]): CliResult =>
  suggest?.length ? { lines, effect, suggest } : { lines, effect };
const err = (lines: string[], suggest?: string[]): CliResult =>
  suggest?.length ? { lines, effect: { kind: "none" }, error: true, suggest } : { lines, effect: { kind: "none" }, error: true };

/** Read-only house-desk commands that already exist in console.ts. Passed
 *  through rather than reimplemented, so the CLI and the desk can never drift. */
const DESK = new Set([
  "status", "pnl", "position", "scan", "proof", "why",
  "trades", "basis", "lp", "universe", "tools", "wallet",
]);

// Two helps, because one help serving both audiences serves neither. The
// default answers "what do I do here", which is what somebody types /help to
// find out. The full index is a reference, and a reference read by a newcomer
// is a wall: 32 lines and 25 commands, most of which mean nothing until you
// have used the thing for a while.
const HELP = [
  "type a message to talk to your agent. commands start with a slash.",
  "",
  "  /explore           a short guided tour, one thing at a time",
  "  /whoami            how your agent is set up right now",
  "  /status            what the live desk is doing",
  "  /credits           your balance and what spends it",
  "",
  "  /help all          every command",
  "",
  "messages cost one credit. commands, the desk and all of earn are free.",
];

const HELP_ALL = [
  "every command. anything without a slash is a message to your agent.",
  "",
  "  shape your agent",
  "    /whoami            what your agent is set to right now",
  "    /name <name>       rename it",
  "    /risk <level>      conservative | balanced | aggressive",
  "    /style <style>     concise | balanced | deep",
  "    /focus <a,b>       market-making, yield, directional, research",
  "    /goal <text>       what you want it working toward",
  "    /voice <text>      how it should sound. dry, warm, blunt, your call",
  "    /swarm             send it to argue with our desks, and learn from it",
  "    /reset <field>     clear one setting back to default",
  "",
  "  the desk (live market, read only)",
  "    /status /pnl /position /proof /why /trades",
  "    /basis /lp /scan /universe /tools /wallet",
  "",
  "  credits",
  "    /credits           your balance and what spends it",
  "    /buy               credit packs",
  "    /buy <pack>        start a purchase",
  "",
  "  session",
  "    /explore           a short tour, one thing at a time",
  "    /clear             clear this transcript",
  "    /help              the short version",
  "",
  "  what costs: a message to your agent. one credit each.",
  "  what does not: every command above, the whole desk, and all of earn.",
  "                 earning is never behind the paywall.",
];

/**
 * The tour. Ordered by what a new person actually wants to know, which is not
 * the order the features were built in: what is this thing, is it telling the
 * truth, can I shape it, and only then the parts that need consent or money.
 */
const TOUR: Array<{ title: string; lines: string[]; tryIt: string }> = [
  {
    title: "your agent is yours",
    lines: [
      "it is provisioned to your wallet, with its own memory. it remembers this",
      "conversation between visits, and nobody else's agent shares it.",
    ],
    tryIt: "how would you approach making markets on a thin pool?",
  },
  {
    title: "it reads a live desk, not a training set",
    lines: [
      "the numbers come from a desk reading the chain continuously. you can read",
      "the same thing it does, directly, without asking it.",
    ],
    tryIt: "/status",
  },
  {
    title: "check it rather than trust it",
    lines: [
      "every figure traces to a timestamped reading. /proof is the honest one:",
      "fees earned minus impermanent loss, against simply holding.",
    ],
    tryIt: "/proof",
  },
  {
    title: "shape how it works",
    lines: [
      "risk, style, focus and goal change how it reasons and they stick. /whoami",
      "shows the current setting any time you lose track.",
    ],
    tryIt: "/style concise",
  },
  {
    title: "the market it watches",
    lines: [
      "tokenized stocks trade 24/7 while the real market sleeps, so the on-chain",
      "price drifts from the real one. that gap is most of the opportunity here.",
    ],
    tryIt: "/basis",
  },
  {
    title: "agents talking to each other",
    lines: [
      "our agents hold conversations in public on the swarm tab. yours can join,",
      "but only if you say so: it speaks under the name you gave it.",
    ],
    tryIt: "/swarm",
  },
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
      if (arg.toLowerCase() === "all") return ok(HELP_ALL);
      // The short help ends in things to press rather than things to read.
      return ok(HELP, { kind: "none" }, ["/explore", "/whoami", "/status"]);

    case "clear":
      return ok([], { kind: "clear" });

    case "explore":
    case "tour": {
      // A tour that prints a manual is a manual. Each step is ONE capability and
      // a line the reader can actually type, so exploring means running things
      // rather than reading about them. Stateless: the step is in the argument,
      // so it survives a refresh, is linkable, and can be jumped into anywhere.
      const step = Math.max(1, Math.min(TOUR.length, parseInt(arg, 10) || 1));
      const t = TOUR[step - 1];
      const last = step >= TOUR.length;
      // Both the thing to try and the way onward are SUGGESTIONS, so the reader
      // taps them instead of copying them out. Telling somebody to type
      // "/explore 3" to see page three is the clunkiest possible way to turn a
      // page, and it was doing that five times in a row.
      return ok(
        [
          `(${step}/${TOUR.length}) ${t.title}`,
          ``,
          ...t.lines,
          ``,
          last ? `that is the tour. /help has the full list whenever you want it.` : ``,
        ].filter((l, i, a) => !(l === "" && a[i - 1] === "")),
        { kind: "none" },
        last ? [t.tryIt] : [t.tryIt, `/explore ${step + 1}`],
      );
    }

    case "credits":
      return ok([], { kind: "read", what: "credits" });

    case "buy": {
      // No argument lists the packs; an argument starts that purchase. The
      // router does not know prices, so both are reads and the route answers.
      if (!arg) return ok([], { kind: "read", what: "packs" });
      return ok([], { kind: "buy", pack: arg.toLowerCase() });
    }

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

    case "voice": {
      if (!arg) {
        return err([
          "usage: /voice <how it should sound>",
          `currently: ${settings.voice ?? "not set"}`,
          `  eg  /voice dry and skeptical, never enthusiastic`,
          `      /voice explain like i am new to this, no jargon`,
        ]);
      }
      return ok([], { kind: "settings", patch: { voice: arg } });
    }

    case "swarm": {
      const v = arg.toLowerCase();
      // A bare /swarm is a question, not a mistake. It used to be an error with
      // a one-line summary, which meant the only way to find out what opting in
      // gets you was to opt in. The router cannot answer it (the takeaways live
      // in a ledger), so it delegates, same as /credits.
      if (!v) return ok([], { kind: "read", what: "swarm" });
      if (v !== "on" && v !== "off") {
        return err(["usage: /swarm on|off", "or just /swarm to see where your agent stands."]);
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
        voice: { voice: "" },
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
      // The near miss is a SUGGESTION now, so a typo is one tap from being
      // fixed rather than a sentence telling you to type it again yourself.
      const near = suggest(cmd);
      return err(
        near.length
          ? [`"/${cmd}" is not a command. did you mean ${near[0]}?`]
          : [`"/${cmd}" is not a command. /help lists them.`],
        near.length ? near : ["/help"],
      );
  }
}

/**
 * One suggestion for a near-miss, by edit distance on a small fixed vocabulary.
 * A CLI that answers a typo with nothing but "unknown command" makes people stop
 * exploring, and exploring is the whole point of putting this in front of them.
 */
function suggest(cmd: string): string[] {
  const vocab = ["help", "whoami", "name", "risk", "style", "focus", "goal", "voice", "swarm", "reset", "credits", "buy", "explore", "clear", ...DESK];
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of vocab) {
    const d = distance(cmd, v);
    if (d < bestD) { bestD = d; best = v; }
  }
  // Only offer it when it is actually close. A wrong suggestion is worse than
  // none: it sends someone off to try a command they never meant.
  return best && bestD <= 2 ? [`/${best}`] : [];
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
    `voice   ${s.voice ?? "not set"}`,
    `swarm   ${s.joinSwarm === true ? "on, your agent may speak publicly" : "off"}`,
  ];
}
