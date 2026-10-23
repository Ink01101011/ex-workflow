import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  loadState,
  saveBrief,
  saveHandoff,
  saveState,
  statePath,
  withStateLock,
} from "../adapters/file.ts";
import { next as planNext } from "../brief.ts";
import { complete } from "../complete.ts";
import { WorkflowError, fail } from "../errors.ts";
import { decide } from "../gates.ts";
import { addItem, editItem, getItem, type ItemPatch } from "../items.ts";
import { applyAction, init, validateAction } from "../methodology.ts";
import { openIteration } from "../planner.ts";
import { registerRole } from "../roles.ts";
import { lastEvent } from "../state.ts";
import { scrum } from "../scrum/index.ts";
import { kanban } from "../kanban/index.ts";
import { waterfall } from "../waterfall/index.ts";
import type {
  Accounting,
  Action,
  Handoff,
  ItemStatus,
  Methodology,
  NewItem,
  Role,
  WorkflowState,
} from "../types.ts";

const METHODOLOGIES: Record<string, () => Methodology> = {
  scrum: scrum as () => Methodology,
  kanban: kanban as () => Methodology,
  waterfall: waterfall as () => Methodology,
};

export const USAGE = [
  "exwf init <scrum|kanban|waterfall> --config <file> [--roles <file>]",
  "exwf add <item.json> [--by who]      exwf edit <id> <patch.json> [--by who]",
  "exwf next [--max n]                  exwf complete <id> <handoff.json> --tokens-in n --tokens-out n --duration-ms n --model m",
  "exwf ceremony <name> [input.json] [--by who]",
  "exwf decide <pendingId> approve|reject [--by who] [--note text]",
  "exwf status | board | metrics | pending | lessons",
  "exwf validate <action.json>          exwf role add <manifest.json> | role list",
];

export interface Parsed {
  positional: string[];
  flags: Record<string, string>;
}
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        flags[key] = val;
        i++;
      } else flags[key] = "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    return fail(
      "invalid-input",
      `cannot read JSON from ${file}: ${(e as Error).message}`,
      "check the path and that the file is valid JSON",
    );
  }
}

function methodologyOf(state: WorkflowState): Methodology {
  const f = Object.hasOwn(METHODOLOGIES, state.methodology)
    ? METHODOLOGIES[state.methodology]
    : undefined;
  if (!f)
    fail(
      "config-invalid",
      `methodology "${state.methodology}" is not available in this build`,
      `available: ${Object.keys(METHODOLOGIES).join(", ")}`,
    );
  return f();
}

function num(flags: Record<string, string>, key: string): number {
  const v = Number(flags[key]);
  if (!Number.isFinite(v))
    fail(
      "invalid-input",
      `--${key} must be a number (got ${JSON.stringify(flags[key])})`,
      `pass --${key} <n>`,
    );
  return v;
}

export interface CommandResult {
  exit: 0 | 1 | 2;
  out: unknown;
}

/** Commands that load, change and save the state: they run under .workflow/state.lock. */
const WRITERS = new Set(["init", "add", "edit", "next", "complete", "ceremony", "decide"]);

export async function runCommand(argv: string[], cwd: string): Promise<CommandResult> {
  const [cmd, sub] = parseArgs(argv).positional;
  const writes = cmd !== undefined && (WRITERS.has(cmd) || (cmd === "role" && sub === "add"));
  try {
    return writes ? await withStateLock(cwd, () => execute(argv, cwd)) : await execute(argv, cwd);
  } catch (e) {
    if (e instanceof WorkflowError) return { exit: 1, out: { ok: false, error: e.toJSON() } };
    throw e;
  }
}

async function execute(argv: string[], cwd: string): Promise<CommandResult> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  const by = flags["by"] ?? "human";
  const now = new Date().toISOString();
  switch (cmd) {
    case "init": {
      const [name] = rest;
      const f = name && Object.hasOwn(METHODOLOGIES, name) ? METHODOLOGIES[name] : undefined;
      if (!f || !flags["config"]) return { exit: 2, out: { ok: false, usage: USAGE } };
      try {
        await stat(statePath(cwd));
        fail(
          "invalid-input",
          `${statePath(cwd)} already exists`,
          "delete .workflow/state.json to start over",
        );
      } catch (e) {
        if (e instanceof WorkflowError) throw e;
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const config = await readJson<unknown>(path.resolve(cwd, flags["config"]));
      const roles = flags["roles"]
        ? await readJson<Role[]>(path.resolve(cwd, flags["roles"]))
        : undefined;
      const res = init(
        roles
          ? { methodology: f(), config, roles, by, now }
          : { methodology: f(), config, by, now },
      );
      await saveState(cwd, res.state);
      return {
        exit: 0,
        out: {
          ok: true,
          warnings: res.warnings,
          state: {
            methodology: res.state.methodology,
            stages: res.state.stages.map((s) => s.id),
            roles: Object.keys(res.state.roles),
          },
        },
      };
    }
    case "add": {
      if (!rest[0]) return { exit: 2, out: { ok: false, usage: USAGE } };
      const state = await loadState(cwd);
      const item = await readJson<NewItem>(path.resolve(cwd, rest[0]));
      const res = applyAction(
        state,
        methodologyOf(state),
        { type: "item.add", by, payload: { item } },
        (s) => addItem(s, item, by, now),
      );
      await saveState(cwd, res.state);
      return {
        exit: 0,
        out: { ok: true, warnings: res.warnings, item: getItem(res.state, item.id) },
      };
    }
    case "edit": {
      if (!rest[0] || !rest[1]) return { exit: 2, out: { ok: false, usage: USAGE } };
      const state = await loadState(cwd);
      const id = rest[0];
      const patch = await readJson<ItemPatch>(path.resolve(cwd, rest[1]));
      const res = applyAction(
        state,
        methodologyOf(state),
        { type: "item.edit", by, payload: { id, patch } },
        (s) => editItem(s, id, patch, by, now),
      );
      await saveState(cwd, res.state);
      return { exit: 0, out: { ok: true, warnings: res.warnings, item: getItem(res.state, id) } };
    }
    case "next": {
      const state = await loadState(cwd);
      const opts = flags["max"] ? { max: num(flags, "max"), now } : { now };
      const res = planNext(state, methodologyOf(state), opts);
      await saveState(cwd, res.state);
      for (const b of res.briefs) await saveBrief(cwd, b);
      return {
        exit: 0,
        out: { ok: true, reason: res.reason ?? null, skipped: res.skipped, briefs: res.briefs },
      };
    }
    case "complete": {
      if (!rest[0] || !rest[1]) return { exit: 2, out: { ok: false, usage: USAGE } };
      const state = await loadState(cwd);
      const handoff = await readJson<Handoff>(path.resolve(cwd, rest[1]));
      if (handoff.item !== rest[0])
        fail(
          "handoff-invalid",
          `handoff.item "${handoff.item}" differs from the command's item "${rest[0]}"`,
          "make them match",
        );
      const role = flags["role"] ?? handoff.role;
      const durationMs = num(flags, "duration-ms");
      const acc: Accounting = {
        item: rest[0],
        role,
        model: flags["model"] ?? "",
        tokensIn: num(flags, "tokens-in"),
        tokensOut: num(flags, "tokens-out"),
        durationMs,
        startedAt: new Date(Date.parse(now) - durationMs).toISOString(),
        endedAt: now,
      };
      const res = complete(state, methodologyOf(state), { ...handoff, role }, acc, now);
      await saveState(cwd, res.state);
      await saveHandoff(cwd, handoff, res.state.events.length);
      return {
        exit: 0,
        out: { ok: true, warnings: res.warnings, item: getItem(res.state, rest[0]) },
      };
    }
    case "ceremony": {
      if (!rest[0]) return { exit: 2, out: { ok: false, usage: USAGE } };
      const state = await loadState(cwd);
      const m = methodologyOf(state);
      const c = Object.hasOwn(m.ceremonies, rest[0]) ? m.ceremonies[rest[0]] : undefined;
      if (!c)
        fail(
          "unknown-ceremony",
          `"${rest[0]}" is not a ${m.name} ceremony`,
          `available: ${Object.keys(m.ceremonies).join(", ")}`,
        );
      const input = rest[1]
        ? await readJson<Record<string, unknown>>(path.resolve(cwd, rest[1]))
        : {};
      const res = c(state, { ...input, by, now });
      await saveState(cwd, res.state);
      return {
        exit: 0,
        out: { ok: true, warnings: res.warnings, lastEvent: lastEvent(res.state) },
      };
    }
    case "decide": {
      if (!rest[0] || (rest[1] !== "approve" && rest[1] !== "reject"))
        return { exit: 2, out: { ok: false, usage: USAGE } };
      const state = await loadState(cwd);
      const entry = state.pending.find((p) => p.id === rest[0]);
      const s2 = decide(
        state,
        rest[0],
        rest[1],
        by,
        flags["note"] ?? "",
        now,
        methodologyOf(state),
      );
      await saveState(cwd, s2);
      return { exit: 0, out: { ok: true, item: entry?.item ? getItem(s2, entry.item) : null } };
    }
    case "status": {
      const state = await loadState(cwd);
      const m = methodologyOf(state);
      const counts: Record<ItemStatus, number> = {
        todo: 0,
        in_progress: 0,
        blocked: 0,
        review: 0,
        awaiting_human: 0,
        done: 0,
        dropped: 0,
      };
      for (const i of Object.values(state.items)) counts[i.status] += 1;
      return {
        exit: 0,
        out: {
          ok: true,
          methodology: state.methodology,
          openIteration: openIteration(state) ?? null,
          counts,
          pending: state.pending,
          lastEvent: lastEvent(state),
          report: m.report ? m.report(state) : null,
        },
      };
    }
    case "board": {
      const state = await loadState(cwd);
      const columns = state.stages.map((st) => ({
        stage: st.id,
        wipLimit: st.wipLimit ?? null,
        items: Object.values(state.items)
          .filter((i) => i.stage === st.id && i.status !== "dropped")
          .map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            role: i.role ?? null,
            age: i.transitions.length
              ? Date.parse(now) - Date.parse(i.transitions[i.transitions.length - 1]!.at)
              : null,
          })),
      }));
      return { exit: 0, out: { ok: true, columns } };
    }
    case "metrics": {
      const state = await loadState(cwd);
      return { exit: 0, out: { ok: true, metrics: methodologyOf(state).metrics(state) } };
    }
    case "pending":
      return { exit: 0, out: { ok: true, pending: (await loadState(cwd)).pending } };
    case "lessons":
      return { exit: 0, out: { ok: true, lessons: (await loadState(cwd)).lessons } };
    case "validate": {
      if (!rest[0]) return { exit: 2, out: { ok: false, usage: USAGE } };
      const state = await loadState(cwd);
      const action = await readJson<Action>(path.resolve(cwd, rest[0]));
      return {
        exit: 0,
        out: { ok: true, violations: validateAction(state, methodologyOf(state), action) },
      };
    }
    case "role": {
      const state = await loadState(cwd);
      if (rest[0] === "list")
        return {
          exit: 0,
          out: { ok: true, roles: Object.keys(state.roles), detail: state.roles },
        };
      if (rest[0] === "add" && rest[1]) {
        const s2 = registerRole(state, await readJson<Role>(path.resolve(cwd, rest[1])), by, now);
        await saveState(cwd, s2);
        return { exit: 0, out: { ok: true, roles: Object.keys(s2.roles) } };
      }
      return { exit: 2, out: { ok: false, usage: USAGE } };
    }
    default:
      return { exit: 2, out: { ok: false, usage: USAGE } };
  }
}
