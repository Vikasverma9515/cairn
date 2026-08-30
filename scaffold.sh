#!/bin/bash
# Creates the Cairn repo skeleton. Run once, then push to GitHub.
# Usage: bash scaffold.sh

set -e
mkdir -p cairn && cd cairn

mkdir -p packages/core/src packages/indexer/src packages/sdk/src
mkdir -p examples fixtures

# --- root ---
cat > package.json <<'EOF'
{
  "name": "cairn",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "determinism": "bash scripts/check-determinism.sh"
  }
}
EOF

cat > .gitignore <<'EOF'
node_modules
dist
*.log
.cairn-cache
ui-manifest.json
.env
EOF

cat > README.md <<'EOF'
# Cairn

Your app explains itself to your users. Generated from your code, in your CI.

```bash
npx cairn build .        # produces ui-manifest.json
```

```jsx
import { Copilot } from "@cairn/sdk";
<Copilot manifest="/ui-manifest.json" />
```

Status: pre-alpha. See BUILD_PLAN.md.
EOF

cat > LATER.md <<'EOF'
# Ideas parked until after Phase 5
(Anything that isn't explain+highlight on Next.js App Router goes here.)
EOF

# --- core: the manifest types ---
cat > packages/core/package.json <<'EOF'
{ "name": "@cairn/core", "version": "0.0.1", "main": "src/index.ts" }
EOF

cat > packages/core/src/index.ts <<'EOF'
// The manifest schema. Freeze this early — everything depends on it.

export type Verb = "explain" | "highlight" | "open" | "navigate" | "do";

export interface Element {
  id: string;
  label: string;
  selector: string;
  fallbacks: string[];
  does: string;
  confidence: number;
  evidence: string[];
}

export interface Page {
  id: string;
  route: string;
  file: string;
  title: string;
  purpose: string;
  whenToUse: string;
  confidence: number;
  elements: Element[];
}

export interface Manifest {
  version: "1";
  commit: string;
  generatedAt: string;
  pages: Page[];
  dead: string[];
  conflicts: {
    candidates: string[];
    chose: string;
    reason: string;
    confidence: number;
  }[];
}
EOF

# --- indexer ---
cat > packages/indexer/package.json <<'EOF'
{
  "name": "@cairn/indexer",
  "version": "0.0.1",
  "bin": { "cairn": "./src/cli.ts" },
  "dependencies": { "ts-morph": "^23.0.0" }
}
EOF

cat > packages/indexer/src/cli.ts <<'EOF'
// Phase 1 starts here.
// Commands: scan (L1 facts), build (full manifest)
console.log("cairn: not implemented yet — start with Phase 0 kill test");
EOF

# --- sdk ---
cat > packages/sdk/package.json <<'EOF'
{
  "name": "@cairn/sdk",
  "version": "0.0.1",
  "main": "src/index.tsx",
  "peerDependencies": { "react": ">=18" }
}
EOF

cat > packages/sdk/src/index.tsx <<'EOF'
// Phase 3 starts here.
export function Copilot(_props: { manifest: string }) {
  return null;
}
EOF

# --- determinism check (run in CI from day one) ---
mkdir -p scripts
cat > scripts/check-determinism.sh <<'EOF'
#!/bin/bash
# Same code in must produce byte-identical output.
set -e
npx cairn scan ./examples/demo-app > /tmp/a.json
npx cairn scan ./examples/demo-app > /tmp/b.json
diff /tmp/a.json /tmp/b.json && echo "DETERMINISTIC OK"
EOF
chmod +x scripts/check-determinism.sh

git init -q
git add -A
git commit -qm "scaffold: cairn monorepo"

echo ""
echo "Done. Next:"
echo "  1. cd cairn"
echo "  2. create an empty repo on github.com (do NOT add a README)"
echo "  3. git remote add origin git@github.com:<you>/cairn.git"
echo "  4. git push -u origin main"
