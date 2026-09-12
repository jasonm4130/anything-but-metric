import { spawnSync } from "node:child_process";

const secret = process.env.TURNSTILE_SECRET_KEY;
if (!secret) {
  console.error("Load TURNSTILE_SECRET_KEY through your local .env.op before syncing the Worker secret.");
  process.exit(1);
}
const result = spawnSync("npx", ["wrangler", "secret", "put", "TURNSTILE_SECRET_KEY"], {
  input: secret,
  stdio: ["pipe", "inherit", "inherit"]
});
if (result.error) {
  console.error("Could not start Wrangler to install the Worker secret.");
  process.exit(1);
}
process.exit(result.status ?? 1);
