#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema } from "@cairn/core";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";
import { describeAll } from "./l3-describe";
import { AnthropicDescribeClient } from "./llm";
import { assembleManifest } from "./manifest";

async function main(): Promise<void> {
  const [command, dirArg] = process.argv.slice(2);
  const dir = dirArg ?? ".";

  if (command === "scan") {
    const facts = scanL1(dir);
    process.stdout.write(JSON.stringify(facts, null, 2) + "\n");
    return;
  }

  if (command === "build") {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("cairn build: ANTHROPIC_API_KEY is not set. Export it and re-run.");
      process.exit(1);
    }

    const facts = scanL1(dir);
    const l2 = computeL2(dir, facts);
    const client = new AnthropicDescribeClient();
    const l3 = await describeAll(dir, facts, client);
    const manifest = assembleManifest(dir, facts, l2, l3);

    const validated = ManifestSchema.parse(manifest);
    const outPath = path.join(path.resolve(dir), "ui-manifest.json");
    fs.writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n");

    console.error(
      `cairn build: ${validated.pages.length} page(s), ${validated.dead.length} dead file(s), ` +
        `${validated.conflicts.length} conflict(s) — L3 cache: ${l3.cacheHits} hit / ${l3.cacheMisses} miss.`,
    );
    console.error(`wrote ${outPath}`);
    return;
  }

  console.error("cairn: not implemented yet — start with Phase 0 kill test");
  console.error("usage: cairn scan <dir> | cairn build <dir>");
  process.exit(command ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
