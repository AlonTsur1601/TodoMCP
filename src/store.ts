import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { StoredPlan } from "./types.js";

const locks = new Map<string, Promise<void>>();

function defaultDataRoot(): string {
  if (process.env.TODO_MCP_DATA_DIR) return resolve(process.env.TODO_MCP_DATA_DIR);
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "TodoMCP");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "TodoMCP");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "todo-mcp");
}

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = resolve(workspaceRoot).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function workspaceHash(workspaceRoot: string): string {
  return createHash("sha256").update(normalizeWorkspaceRoot(workspaceRoot)).digest("hex");
}

async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => { release = done; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      return async () => {
        await handle.close();
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStaleLock(path)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const lock = JSON.parse(raw) as { pid?: unknown };
    if (typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) return false;
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    try {
      return Date.now() - (await stat(path)).mtimeMs > 30_000;
    } catch {
      return false;
    }
  }
}

export class PlanStore {
  readonly dataRoot: string;

  constructor(dataRoot = defaultDataRoot()) {
    this.dataRoot = dataRoot;
  }

  private planPath(workspaceRoot: string, planId: string): string {
    return join(this.dataRoot, "workspaces", workspaceHash(workspaceRoot), "plans", `${planId}.json`);
  }

  async read(workspaceRoot: string, planId: string): Promise<StoredPlan> {
    const path = this.planPath(workspaceRoot, planId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Plan ${planId} was not found for this workspace.`);
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as StoredPlan;
      if (parsed.schemaVersion !== 1 || parsed.planId !== planId) throw new Error("unsupported or mismatched state");
      return parsed;
    } catch (error) {
      throw new Error(`Plan state is corrupt and was not overwritten: ${(error as Error).message}`);
    }
  }

  async write(plan: StoredPlan, event: Record<string, unknown>, expectedStateVersion?: number): Promise<void> {
    const path = this.planPath(plan.workspaceRoot, plan.planId);
    await serial(path, async () => {
      await mkdir(dirname(path), { recursive: true });
      const release = await acquireFileLock(`${path}.lock`);
      try {
        if (expectedStateVersion !== undefined) {
          let current: StoredPlan;
          try {
            current = JSON.parse(await readFile(path, "utf8")) as StoredPlan;
          } catch (error) {
            throw new Error(`Plan changed or disappeared before this update could be saved: ${(error as Error).message}`);
          }
          if (current.stateVersion !== expectedStateVersion) {
            throw new Error("Plan changed concurrently; reload it and retry the operation.");
          }
        }
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporary, path);
        const historyPath = join(dirname(path), `${plan.planId}.history.jsonl`);
        const historyLine = JSON.stringify({ at: new Date().toISOString(), ...event });
        const historyHandle = await open(historyPath, "a");
        try {
          await historyHandle.appendFile(`${historyLine}\n`, "utf8");
        } finally {
          await historyHandle.close();
        }
      } finally {
        await release();
      }
    });
  }
}
