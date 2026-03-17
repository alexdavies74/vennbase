import { spawnSync } from "node:child_process";

const packages = ["@putbase/core", "@putbase/react"];
const publishArgs = process.argv.slice(2);

if (publishArgs[0] === "--") {
  publishArgs.shift();
}

function run(command, args) {
  const rendered = [command, ...args].join(" ");
  console.log(`\n> ${rendered}`);

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const packageName of packages) {
  run("pnpm", ["--filter", packageName, "build"]);
}

for (const packageName of packages) {
  run("pnpm", [
    "--filter",
    packageName,
    "publish",
    "--no-git-checks",
    ...publishArgs,
  ]);
}
