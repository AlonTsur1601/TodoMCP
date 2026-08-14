import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(fileURLToPath(new URL("../install.mjs", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "todo-mcp-installer-test-"));
const codexHome = join(root, "Codex Home with spaces");
const statePath = join(root, "codex-state.json");
const failMarker = join(root, "fail-next-add");
const fakeCli = fileURLToPath(new URL("./fake-codex-cli.mjs", import.meta.url));
const wrapper = join(root, process.platform === "win32" ? "fake codex.cmd" : "fake-codex");
const oldTarget = join(codexHome, "mcp", "todo-mcp");
const oldRegistration = {
  transport: { type: "stdio", command: process.execPath, args: ["old-server.js"], env: { PRESERVED: "yes" } },
};
const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));

function runInstaller(extraEnv = {}) {
  return spawnSync(process.execPath, [join(sourceRoot, "install.mjs")], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      TODO_MCP_CODEX_COMMAND: wrapper,
      FAKE_CODEX_STATE: statePath,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

try {
  await mkdir(oldTarget, { recursive: true });
  await writeFile(join(oldTarget, "old-marker.txt"), "old install\n", "utf8");
  await writeFile(statePath, `${JSON.stringify({ registrations: {
    todo_mcp: oldRegistration,
    preserved_mcp: { transport: { type: "stdio", command: "preserved", args: [], env: {} } },
  } }, null, 2)}\n`, "utf8");
  if (process.platform === "win32") {
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`, "utf8");
  } else {
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`, "utf8");
    await chmod(wrapper, 0o755);
  }

  await writeFile(failMarker, "fail\n", "utf8");
  const failed = runInstaller({ FAKE_CODEX_FAIL_ADD: failMarker });
  assert.notEqual(failed.status, 0, `Injected installer failure unexpectedly succeeded:\n${failed.stdout}\n${failed.stderr}`);
  assert.equal(await readFile(join(oldTarget, "old-marker.txt"), "utf8"), "old install\n");
  let state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.registrations.todo_mcp, oldRegistration);
  assert.ok(state.registrations.preserved_mcp);
  assert.ok(!(await readdir(join(codexHome, "mcp"))).some((name) => name.startsWith(".todo-mcp-")));

  const installed = runInstaller();
  assert.equal(installed.status, 0, `Installer failed:\n${installed.stdout}\n${installed.stderr}`);
  assert.ok(existsSync(join(oldTarget, "dist", "src", "index.js")));
  assert.equal((await readFile(join(oldTarget, ".installed-version"), "utf8")).trim(), manifest.version);
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(state.registrations.todo_mcp.transport.args[0].endsWith("dist\\src\\index.js")
    || state.registrations.todo_mcp.transport.args[0].endsWith("dist/src/index.js"));
  assert.ok(state.registrations.preserved_mcp);
  process.stdout.write("TODO_MCP_INSTALLER_PASS rollback=1 install=1 preserved=1\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
