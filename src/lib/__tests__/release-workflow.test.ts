import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("writes the packaged ZIP digest to SHA256SUMS instead of the dist content digest", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain('ZIP_HASH=$(shasum -a 256 "${ZIP}" | awk \'{print $1}\')');
    expect(workflow).toContain('echo "${ZIP_HASH}  ${ZIP}" > SHA256SUMS.txt');
    expect(workflow).not.toContain('echo "${HASH}  ${ZIP}" > SHA256SUMS.txt');
  });
});
