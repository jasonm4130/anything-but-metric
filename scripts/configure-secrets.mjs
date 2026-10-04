import { spawnSync } from "node:child_process";

// TURNSTILE_SECRET_KEY is required. JEV_DECISIONS_URL and AI_GATEWAY_TOKEN, when loaded, let the
// Worker reach Jev through the gateway's custom OpenRouter route; without both it skips Jev.
// The URL contains the account ID, so it is installed like a secret rather than committed.
const secrets = [["TURNSTILE_SECRET_KEY", true], ["JEV_DECISIONS_URL", false], ["AI_GATEWAY_TOKEN", false]];
if (!process.env.TURNSTILE_SECRET_KEY) {
  console.error("Load TURNSTILE_SECRET_KEY through your local .env.op before syncing the Worker secret.");
  process.exit(1);
}
for (const [name, required] of secrets) {
  const value = process.env[name];
  if (!value) {
    if (!required) console.error(`${name} is not loaded; leaving the Worker's existing value unchanged.`);
    continue;
  }
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"]
  });
  if (result.error) {
    console.error("Could not start Wrangler to install the Worker secret.");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
