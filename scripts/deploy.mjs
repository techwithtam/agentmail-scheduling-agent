import { execFileSync, spawnSync } from "node:child_process";

const status = execFileSync("git", ["status", "--porcelain", "--", "."], { encoding: "utf8" }).trim();
if (status) {
  console.error("Refusing to deploy with uncommitted repository changes.");
  console.error(status);
  process.exit(1);
}

const fullSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const shortSha = fullSha.slice(0, 12);
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, [
  "wrangler",
  "deploy",
  "--tag",
  `git-${shortSha}`,
  "--message",
  `git commit ${fullSha}`,
], { stdio: "inherit" });

process.exit(result.status ?? 1);
