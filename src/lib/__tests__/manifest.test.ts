import { describe, it, expect } from "vitest";
import manifest from "../../../manifest.json";

describe("manifest", () => {
  it("is MV3, asks for LinkedIn and X at install, names noticed only for messaging", () => {
    expect(manifest.manifest_version).toBe(3);
    const json = JSON.stringify(manifest).toLowerCase();
    expect(json).not.toContain("voyager");
    // LinkedIn and X access are granted at install, so noticed's Activity page
    // can refresh both on open with no extra prompt. Accepted cost: Chrome
    // disables the extension on this update for existing installs until the
    // user re-approves; the page then sees no reply and offers the extension.
    expect(manifest.host_permissions).toEqual([
      "https://*.noticed.so/*",
      "*://*.linkedin.com/*",
      "*://*.x.com/*",
      "*://*.twitter.com/*",
    ]);
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest.externally_connectable.matches).toEqual(["https://*.noticed.so/*"]);
    expect(manifest.permissions).toEqual(expect.arrayContaining(["storage", "alarms", "cookies"]));
  });

  it("has the user-facing branding + a compliant description and icon set", () => {
    expect(manifest.name).toBe("noticed Relationships");
    // Chrome Web Store limits: name ≤ 75 chars, description ≤ 132 chars.
    expect(manifest.name.length).toBeLessThanOrEqual(75);
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    // PNG icon set at the standard sizes (no SVG/WebP — unsupported for icons).
    expect(Object.keys(manifest.icons).sort()).toEqual(["128", "16", "32", "48"]);
    for (const p of Object.values(manifest.icons)) expect(p).toMatch(/^icons\/.*\.png$/);
    expect(manifest.action.default_icon["128"]).toBe("icons/icon128.png");
    // No popup: the toolbar button opens noticed's connection page.
    expect(manifest.action).not.toHaveProperty("default_popup");
  });
});
