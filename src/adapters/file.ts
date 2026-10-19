import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fail } from "../errors.ts";
import type { Brief, Handoff, Role, WorkflowState } from "../types.ts";

export const WORKFLOW_DIR = ".workflow";

export function statePath(root: string): string {
  return path.join(root, WORKFLOW_DIR, "state.json");
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  } catch (e) {
    // best effort: remove the temp file if it was created; ignore failure
    await unlink(tmp).catch(() => undefined);
    fail(
      "invalid-input",
      `cannot write ${file}: ${(e as Error).message}`,
      "check the directory exists and is writable",
    );
  }
}

export async function saveState(root: string, state: WorkflowState): Promise<void> {
  await writeAtomic(statePath(root), JSON.stringify(state, null, 2) + "\n");
}

export async function loadState(root: string): Promise<WorkflowState> {
  const file = statePath(root);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    fail(
      "invalid-input",
      `no workflow state at ${file}`,
      "run `exwf init <scrum|kanban|waterfall> --config <file>` in this directory first",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(
      "invalid-input",
      `${file} is not valid JSON: ${(e as Error).message}`,
      "restore it from git or re-run exwf init",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(
      "invalid-input",
      `${file} does not contain a workflow state object`,
      "restore it from git or re-run exwf init",
    );
  }
  const state = parsed as WorkflowState;
  if (state.version !== 1)
    fail(
      "state-version",
      `${file} has schema version ${String(state.version)}; this ex-workflow reads version 1`,
      "upgrade ex-workflow, or run the migration this version documents in its changelog",
    );
  const rolesDir = path.join(root, WORKFLOW_DIR, "roles");
  let manifests: string[] = [];
  try {
    manifests = (await readdir(rolesDir)).filter((f) => f.endsWith(".json"));
  } catch {
    /* no extra roles */
  }
  const roles = { ...state.roles };
  for (const f of manifests) {
    const manifestPath = path.join(rolesDir, f);
    let role: Role;
    try {
      role = JSON.parse(await readFile(manifestPath, "utf8")) as Role;
    } catch (e) {
      fail(
        "invalid-input",
        `role manifest ${manifestPath} is not valid JSON: ${(e as Error).message}`,
        "fix or delete that manifest",
      );
    }
    if (typeof role !== "object" || role === null || typeof role.id !== "string") {
      fail(
        "invalid-input",
        `role manifest ${manifestPath} is not an object with a string id`,
        "a role manifest needs at least an id",
      );
    }
    if (!roles[role.id]) roles[role.id] = role;
  }
  return { ...state, roles };
}

export async function saveBrief(root: string, brief: Brief): Promise<string> {
  const file = path.join(root, WORKFLOW_DIR, "briefs", `${brief.item.id}.json`);
  await writeAtomic(file, JSON.stringify(brief, null, 2) + "\n");
  return file;
}

export async function saveHandoff(root: string, handoff: Handoff, seq: number): Promise<string> {
  const file = path.join(root, WORKFLOW_DIR, "handoffs", `${handoff.item}-${seq}.json`);
  await writeAtomic(file, JSON.stringify(handoff, null, 2) + "\n");
  return file;
}
