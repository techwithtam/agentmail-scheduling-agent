import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../src/scheduler-config.ts", import.meta.url), "utf8");
const placeholderPatterns = [
  /example\.(?:com|agentmail\.to)/i,
  /REPLACE_ME|replace-me/i,
  /:\s*-\d+/,
];

const matches = placeholderPatterns.filter((pattern) => pattern.test(config));
if (matches.length > 0) {
  console.error("Configuration still contains public-template placeholder values.");
  console.error("Edit src/scheduler-config.ts before deploying.");
  process.exit(1);
}

console.log("Scheduler configuration has no known template placeholders.");
