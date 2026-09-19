#!/usr/bin/env node
/**
 * Copies ../models.json (canonical image-generation registry) into this
 * package's models.json and injects "$schema": "./models.schema.json".
 *
 * Usage (from fal-mcp/):
 *   node scripts/sync-models-from-parent.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const parentModels = resolve(root, "..", "models.json");
const dest = join(root, "models.json");

if (!existsSync(parentModels)) {
  console.error(`[sync-models] parent models.json not found at ${parentModels}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(parentModels, "utf8"));
data["$schema"] = "./models.schema.json";
writeFileSync(dest, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(
  `[sync-models] synced ${Object.keys(data.models || {}).length} models from ${parentModels} → ${dest}`
);
