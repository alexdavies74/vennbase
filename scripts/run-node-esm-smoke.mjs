import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packageDirArg = process.argv[2] ?? ".";
const packageDir = resolve(process.cwd(), packageDirArg);
const entryPath = resolve(packageDir, "dist/index.js");

await access(entryPath);

const entryUrl = pathToFileURL(entryPath).href;
const smokeSource = `import(${JSON.stringify(entryUrl)}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});`;

const result = spawnSync(process.execPath, ["--input-type=module", "--eval", smokeSource], {
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Node ESM import smoke passed for ${entryPath}`);
