import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fail } from "../errors.ts";
import { assertValid, roleSchema, workflowStateSchema } from "../schema/index.ts";
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

export interface LockOptions {
  retries?: number;
  intervalMs?: number;
  staleMs?: number;
}

/** Run `fn` while holding `.workflow/state.lock`, so concurrent exwf commands cannot lose each other's updates. */
export async function withStateLock<T>(
  root: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const { retries = 40, intervalMs = 50, staleMs = 60_000 } = opts;
  const lock = path.join(root, WORKFLOW_DIR, "state.lock");
  await mkdir(path.dirname(lock), { recursive: true });
  let held = false;
  for (let attempt = 0; !held; attempt++) {
    try {
      const fh = await open(lock, "wx");
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await fh.close();
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const snap = await stat(lock).catch(() => undefined);
      if (snap && Date.now() - snap.mtimeMs > staleMs) {
        // re-stat just before unlink: if another recoverer already replaced the lock, leave it alone
        const now = await stat(lock).catch(() => undefined);
        if (now && now.ino === snap.ino && now.mtimeMs === snap.mtimeMs)
          await unlink(lock).catch(() => undefined);
        continue;
      }
      if (attempt >= retries)
        fail(
          "invalid-input",
          "another exwf command holds .workflow/state.lock",
          "retry, or delete the file if no exwf process is running",
        );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

export async function saveState(root: string, state: WorkflowState): Promise<void> {
  const json = JSON.stringify(state, null, 2) + "\n";
  assertValid(workflowStateSchema, JSON.parse(json), statePath(root));
  await writeAtomic(statePath(root), json);
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
  assertValid(workflowStateSchema, parsed, file);
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
    assertValid(roleSchema, role, `role manifest ${manifestPath}`);
    if (!roles[role.id]) roles[role.id] = role;
  }
  return { ...state, roles };
}

function inWorkflowDir(root: string, file: string): string {
  if (!path.resolve(file).startsWith(path.resolve(root, WORKFLOW_DIR) + path.sep))
    fail(
      "invalid-input",
      `${file} resolves outside ${WORKFLOW_DIR}/`,
      "use a plain item id (letters, digits, - _ .)",
    );
  return file;
}

export async function saveBrief(root: string, brief: Brief): Promise<string> {
  const file = inWorkflowDir(
    root,
    path.join(root, WORKFLOW_DIR, "briefs", `${brief.item.id}.json`),
  );
  await writeAtomic(file, JSON.stringify(brief, null, 2) + "\n");
  return file;
}

export async function saveHandoff(root: string, handoff: Handoff, seq: number): Promise<string> {
  const file = inWorkflowDir(
    root,
    path.join(root, WORKFLOW_DIR, "handoffs", `${handoff.item}-${seq}.json`),
  );
  await writeAtomic(file, JSON.stringify(handoff, null, 2) + "\n");
  return file;
}
