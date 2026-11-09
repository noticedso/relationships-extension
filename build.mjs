import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

// Clean dist so every build is from scratch (reproducible).
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// Dev-only features (e.g. the test-mode toggle) compile in ONLY when EXT_DEV=1.
// The published artifact builds with __DEV__ = false (default), so the dev
// affordances are dead-code-eliminated and the reproducible hash is stable.
const DEV = process.env.EXT_DEV === "1";

// Deterministic esbuild options shared by every entry point.
const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  define: { __DEV__: JSON.stringify(DEV) },
};

// Entry points, sorted by output path for stable ordering.
const entries = [
  {
    entryPoints: [path.join(root, "src", "service-worker.ts")],
    outfile: path.join(dist, "service-worker.js"),
  },
].sort((a, b) => a.outfile.localeCompare(b.outfile));

for (const entry of entries) {
  await build({ ...shared, ...entry });
}

// Copy static files into dist.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (DEV) {
  manifest.name = "noticed Relationships (development)";
  manifest.host_permissions.push("http://localhost:3011/*");
  manifest.externally_connectable.matches.push("http://localhost:3011/*");
}
fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// Copy icon set (sorted for stable ordering).
const iconsSrc = path.join(root, "icons");
const iconsDist = path.join(dist, "icons");
fs.mkdirSync(iconsDist, { recursive: true });
for (const file of fs.readdirSync(iconsSrc).sort()) {
  fs.copyFileSync(path.join(iconsSrc, file), path.join(iconsDist, file));
}
