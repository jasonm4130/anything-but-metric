import { spawnSync } from "node:child_process";

if (!process.env.PUBLIC_TURNSTILE_SITE_KEY) {
  console.error("Load the production site key with op run --env-file=.env.op -- npm run deploy.");
  process.exit(1);
}

// Version deployment preserves the existing custom domain and its routes.
const tag = `release-${Date.now()}`;
for (const [command, args] of [
  ["npm", ["run", "build"]],
  ["npx", ["wrangler", "versions", "upload", "--tag", tag]],
  ["npx", ["wrangler", "versions", "deploy", "--version-tag", `${tag}@100`, "--yes"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
