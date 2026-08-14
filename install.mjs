#!/usr/bin/env node
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const installParent = join(codexHome, "mcp");
const target = join(installParent, "todo-mcp");
const staging = join(installParent, `.todo-mcp-stage-${randomUUID()}`);
const backup = join(installParent, `.todo-mcp-backup-${randomUUID()}`);

function findOnPath(filenames) {
  const directories = (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean);
  for (const filename of filenames) {
    for (const directory of directories) {
      const candidate = join(directory.replace(/^"|"$/g, ""), filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  return filenames[0];
}

const npmCommand = process.platform === "win32" ? findOnPath(["npm.cmd"]) : "npm";

function resolveCodexCommand() {
  if (process.env.TODO_MCP_CODEX_COMMAND) return process.env.TODO_MCP_CODEX_COMMAND;
  if (process.env.CODEX_CLI_PATH && existsSync(process.env.CODEX_CLI_PATH)) return process.env.CODEX_CLI_PATH;
  if (process.platform !== "win32") return "codex";
  return findOnPath(["codex.cmd", "codex.exe"]);
}

const codexCommand = resolveCodexCommand();

function run(command, args, options = {}) {
  const isWindowsWrapper = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  const actualCommand = isWindowsWrapper ? process.env.ComSpec ?? "cmd.exe" : command;
  const actualArgs = isWindowsWrapper
    ? ["/d", "/s", "/c", `call "${command.replaceAll('"', '""')}" ${args.map((arg) => `"${String(arg).replaceAll('"', '""')}"`).join(" ")}`]
    : args;
  const result = spawnSync(actualCommand, actualArgs, {
    cwd: options.cwd ?? sourceRoot,
    env: process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    windowsVerbatimArguments: isWindowsWrapper,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.\n${result.stderr ?? ""}`);
  }
  return result;
}

function assertRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) throw new Error("TodoMCP requires Node.js 20 or newer.");
  run(codexCommand, ["--version"], { capture: true });
}

function getPreviousRegistration() {
  const result = run(codexCommand, ["mcp", "get", "todo_mcp", "--json"], { capture: true, allowFailure: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Existing todo_mcp registration returned invalid JSON; installation stopped without changing it.");
  }
}

function removeRegistration() {
  run(codexCommand, ["mcp", "remove", "todo_mcp"], { capture: true, allowFailure: true });
}

function addRegistration(scriptPath) {
  run(codexCommand, ["mcp", "add", "todo_mcp", "--", process.execPath, scriptPath], { capture: true });
}

function restoreRegistration(previous) {
  if (!previous) return;
  const transport = previous.transport ?? previous;
  if (transport.type === "stdio" || transport.command) {
    const args = ["mcp", "add", "todo_mcp"];
    for (const [key, value] of Object.entries(transport.env ?? {})) args.push("--env", `${key}=${value}`);
    args.push("--", transport.command, ...(transport.args ?? []));
    run(codexCommand, args, { capture: true });
    return;
  }
  if (transport.type === "streamable_http" || transport.url) {
    run(codexCommand, ["mcp", "add", "todo_mcp", "--url", transport.url], { capture: true });
    return;
  }
  throw new Error("The previous todo_mcp registration used an unsupported transport and could not be restored automatically.");
}

async function prepareStaging() {
  await mkdir(staging, { recursive: true });
  await mkdir(join(staging, "dist"), { recursive: true });
  await cp(join(sourceRoot, "dist", "src"), join(staging, "dist", "src"), { recursive: true });
  await cp(join(sourceRoot, "package.json"), join(staging, "package.json"));
  await cp(join(sourceRoot, "package-lock.json"), join(staging, "package-lock.json"));
  await cp(join(sourceRoot, "LICENSE"), join(staging, "LICENSE"));
  await cp(join(sourceRoot, "README.md"), join(staging, "README.md"));
  run(npmCommand, ["ci", "--omit=dev", "--ignore-scripts"], { cwd: staging, capture: true });
  const manifest = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
  await writeFile(join(staging, ".installed-version"), `${manifest.version}\n`, "utf8");
}

async function main() {
  assertRuntime();
  run(npmCommand, ["ci"], { cwd: sourceRoot });
  run(npmCommand, ["run", "build"], { cwd: sourceRoot });
  run(npmCommand, ["run", "smoke"], { cwd: sourceRoot });
  await mkdir(installParent, { recursive: true });
  try {
    await prepareStaging();
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const previousRegistration = getPreviousRegistration();
  let movedExisting = false;
  try {
    try {
      await rename(target, backup);
      movedExisting = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(staging, target);
    removeRegistration();
    addRegistration(join(target, "dist", "src", "index.js"));
    if (movedExisting) await rm(backup, { recursive: true, force: true });
    process.stdout.write("TodoMCP installed and registered as todo_mcp. Restart Codex before use.\n");
  } catch (error) {
    removeRegistration();
    try { restoreRegistration(previousRegistration); } catch (restoreError) {
      process.stderr.write(`Registration rollback also failed: ${restoreError.message}\n`);
    }
    await rm(target, { recursive: true, force: true });
    if (movedExisting) await rename(backup, target);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`TodoMCP installation failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
