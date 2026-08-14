import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const testDirectory = join(root, "dist", "test");
const testFiles = (await readdir(testDirectory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testDirectory, name));

if (testFiles.length === 0) throw new Error(`No compiled test files were found in ${testDirectory}.`);

const result = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
