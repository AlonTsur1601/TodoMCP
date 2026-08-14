import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";

const statePath = process.env.FAKE_CODEX_STATE;
if (!statePath) throw new Error("FAKE_CODEX_STATE is required.");
const args = process.argv.slice(2);

async function load() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function save(state) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

if (args[0] === "--version") {
  process.stdout.write("codex-test 1.0.0\n");
  process.exit(0);
}

if (args[0] !== "mcp" || !["get", "remove", "add"].includes(args[1])) process.exit(64);
const state = await load();
const action = args[1];
const name = args[2];

if (action === "get") {
  const registration = state.registrations[name];
  if (!registration) process.exit(1);
  process.stdout.write(`${JSON.stringify(registration)}\n`);
  process.exit(0);
}

if (action === "remove") {
  delete state.registrations[name];
  await save(state);
  process.exit(0);
}

if (name === "todo_mcp" && process.env.FAKE_CODEX_FAIL_ADD && existsSync(process.env.FAKE_CODEX_FAIL_ADD)) {
  await rm(process.env.FAKE_CODEX_FAIL_ADD, { force: true });
  process.stderr.write("injected add failure\n");
  process.exit(2);
}

const separator = args.indexOf("--");
const urlIndex = args.indexOf("--url");
if (urlIndex >= 0) {
  state.registrations[name] = { transport: { type: "streamable_http", url: args[urlIndex + 1] } };
} else if (separator >= 0) {
  const env = {};
  for (let index = 3; index < separator; index += 1) {
    if (args[index] === "--env") {
      const [key, ...value] = args[index + 1].split("=");
      env[key] = value.join("=");
      index += 1;
    }
  }
  state.registrations[name] = {
    transport: { type: "stdio", command: args[separator + 1], args: args.slice(separator + 2), env },
  };
} else {
  process.exit(64);
}
await save(state);
