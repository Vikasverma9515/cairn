#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema } from "@cairn/core";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";
import { describeAll } from "./l3-describe";
import { AnthropicDescribeClient, GroqDescribeClient } from "./llm";
import { assembleManifest } from "./manifest";
import { diffManifests, formatDiffAsText } from "./diff";
import { generateDocsMarkdown } from "./docs";

function parseArgs(rest: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = rest[i + 1] ?? "";
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const dir = positional[0] ?? ".";

  if (command === "scan") {
    const facts = scanL1(dir);
    process.stdout.write(JSON.stringify(facts, null, 2) + "\n");
    return;
  }

  if (command === "build") {
    const provider = flags.provider === "groq" ? "groq" : "anthropic";

    if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
      console.error("cairn build: ANTHROPIC_API_KEY is not set. Export it, or pass --provider groq, and re-run.");
      process.exit(1);
    }
    if (provider === "groq" && !process.env.GROQ_API_KEYS) {
      console.error("cairn build --provider groq: GROQ_API_KEYS is not set (comma-separated). Export it and re-run.");
      process.exit(1);
    }

    const facts = scanL1(dir);
    const l2 = computeL2(dir, facts);
    const client = provider === "groq" ? new GroqDescribeClient() : new AnthropicDescribeClient();
    const l3 = await describeAll(dir, facts, client);
    const manifest = assembleManifest(dir, facts, l2, l3);

    const validated = ManifestSchema.parse(manifest);
    const outPath = path.join(path.resolve(dir), "ui-manifest.json");
    fs.writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n");

    console.error(
      `cairn build (${provider}): ${validated.pages.length} page(s), ${validated.dead.length} dead file(s), ` +
        `${validated.conflicts.length} conflict(s) — L3 cache: ${l3.cacheHits} hit / ${l3.cacheMisses} miss.`,
    );
    console.error(`wrote ${outPath}`);
    return;
  }

  if (command === "diff") {
    const [oldPath, newPath] = positional;
    if (!oldPath || !newPath) {
      console.error("usage: cairn diff <old-manifest.json> <new-manifest.json>");
      process.exit(1);
    }
    const before = ManifestSchema.parse(JSON.parse(fs.readFileSync(oldPath, "utf8")));
    const after = ManifestSchema.parse(JSON.parse(fs.readFileSync(newPath, "utf8")));
    console.log(formatDiffAsText(diffManifests(before, after)));
    return;
  }

  if (command === "docs") {
    const manifestPath = path.join(path.resolve(dir), "ui-manifest.json");
    if (!fs.existsSync(manifestPath)) {
      console.error(`cairn docs: no ${manifestPath} — run \`cairn build ${dir}\` first.`);
      process.exit(1);
    }
    const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const outPath = path.join(path.resolve(dir), "CAIRN_DOCS.md");
    fs.writeFileSync(outPath, generateDocsMarkdown(manifest) + "\n");
    console.error(`wrote ${outPath}`);
    return;
  }

  console.error("usage:");
  console.error("  cairn scan <dir>");
  console.error("  cairn build <dir> [--provider anthropic|groq]");
  console.error("  cairn diff <old-manifest.json> <new-manifest.json>");
  console.error("  cairn docs <dir>   (reads <dir>/ui-manifest.json, writes <dir>/CAIRN_DOCS.md)");
  process.exit(command ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
