import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");

if (!fs.existsSync(dist)) {
  console.error("dist/ is missing — run `node build.mjs` first.");
  process.exit(1);
}

// Recursively collect every file under dist, as paths relative to dist.
function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(path.relative(dist, full));
    }
  }
  return out;
}

// Sort relative paths for a deterministic order (POSIX separators for stability).
const files = listFiles(dist)
  .map((p) => p.split(path.sep).join("/"))
  .sort();

const hash = crypto.createHash("sha256");
for (const rel of files) {
  hash.update(rel);
  hash.update("\0");
  hash.update(fs.readFileSync(path.join(dist, rel.split("/").join(path.sep))));
  hash.update("\0");
}

console.log(hash.digest("hex"));
