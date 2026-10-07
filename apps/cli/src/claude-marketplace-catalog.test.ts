import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readClaudeMarketplaceCatalog,
  selectClaudeMarketplaceEntry,
} from "./claude-marketplace-context.js";
import {
  normalizeClaudePluginRenames,
  resolveClaudePluginRename,
} from "./claude-plugin-selection.js";
import type { ProductHarnessReadGuard } from "./product-harness-probe-files.js";
import {
  createClaudeContextFixtures,
  hooks,
} from "./__tests__/claude-plugin-context-fixture.js";

import {
  claudeMarketplaceLoadingSource as observeMarketplaceSource,
  claudeMarketplaceManifestConflict,
} from "./claude-discovery.js";

const claudeMarketplaceLoadingSource = (
  ...input: Parameters<typeof observeMarketplaceSource>
) => {
  const observed = observeMarketplaceSource(...input);
  const { entry, ...loading } = observed;
  expect(Object.isFrozen(entry)).toBe(true);
  return loading;
};

const { cachedContext } = createClaudeContextFixtures();

describe("catalog observation before cache selection", () => {
  it("retains the same consulted documents without reading or relabeling a cache", async () => {
    const value = await cachedContext();
    const catalogPath = join(
      value.catalog,
      ".claude-plugin",
      "marketplace.json",
    );
    await writeFile(
      catalogPath,
      JSON.stringify({
        name: "market",
        renames: { old: "current" },
        plugins: [
          { name: "current", source: "./current", hooks: hooks("Stop") },
        ],
      }),
    );
    const guards: ProductHarnessReadGuard[] = [];
    const observed = await readClaudeMarketplaceCatalog(
      join(value.home, ".claude", "plugins"),
      "market",
      (guard) => guards.push(guard),
    );
    expect(guards.map((guard) => guard.targetPath)).toEqual([
      join(value.home, ".claude", "plugins", "known_marketplaces.json"),
      catalogPath,
    ]);
    expect(Object.isFrozen(observed.catalog.plugins)).toBe(true);
    // This proves catalog resolution only, not source-policy admission.
    const selected = resolveClaudePluginRename(
      "old",
      new Set(["current"]),
      normalizeClaudePluginRenames(observed.catalog.renames),
    );
    expect(selected).toBe("current");
    expect(
      JSON.parse(
        selectClaudeMarketplaceEntry(observed, selected!).hooksDeclarationJson!,
      ),
    ).toEqual(hooks("Stop"));
    expect(() => selectClaudeMarketplaceEntry(observed, "old")).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(
      JSON.parse(
        await readFile(join(value.home, ".claude", "settings.json"), "utf8"),
      ),
    ).toEqual({ enabledPlugins: { "ordinary@market": true } });
  });

  it("selects from the collected catalog rather than a later replacement", async () => {
    const value = await cachedContext();
    const guards: ProductHarnessReadGuard[] = [];
    const observed = await readClaudeMarketplaceCatalog(
      join(value.home, ".claude", "plugins"),
      "market",
      (guard) => guards.push(guard),
    );
    const before = selectClaudeMarketplaceEntry(observed, "ordinary");
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "market", plugins: [] }),
    );
    expect(selectClaudeMarketplaceEntry(observed, "ordinary")).toEqual(before);
    expect(guards).toHaveLength(2);
  });
});

describe("recorded catalog object-source normalization", () => {
  it.each([
    ["./plugins/", "/market/plugins/ordinary"],
    ["plugins", "/market/plugins/ordinary"],
    [".", "/market/ordinary"],
    ["./", "/market/ordinary"],
  ])(
    "rewrites a bare source under native metadata.pluginRoot %s",
    (pluginRoot, localPath) => {
      expect(
        claudeMarketplaceLoadingSource(
          { name: "ordinary", source: "ordinary" },
          { source: "directory", path: "/market" },
          "/market",
          { pluginRoot },
        ),
      ).toEqual({ stringSource: true, stubbed: false, localPath });
    },
  );
  it.each([
    undefined,
    "",
    "../outside",
    "/outside",
    "a\\b",
    "C:plugins",
    "plugins//nested",
    "plugins/./nested",
    "plugins/../nested",
  ])("does not fabricate a bare-source root from %s", (pluginRoot) => {
    expect(
      claudeMarketplaceLoadingSource(
        { name: "ordinary", source: "ordinary" },
        { source: "directory", path: "/market" },
        "/market",
        { pluginRoot },
      ),
    ).toEqual({ stringSource: false, stubbed: true });
    expect(
      claudeMarketplaceLoadingSource(
        { name: "ordinary", source: "./ordinary" },
        { source: "directory", path: "/market" },
        "/market",
        { pluginRoot },
      ),
    ).toEqual({
      stringSource: true,
      stubbed: false,
      localPath: "/market/ordinary",
    });
  });
  it.each([
    { source: "github", repo: 1 },
    { source: "github", repo: "valid", sha: "moving-ref" },
    { source: "git", url: "https://example.invalid/repo" },
    { source: "git-subdir", url: "valid", path: "" },
    { source: "command", command: "unused", timeout: 601 },
    { source: "command", command: "unused\ncommand" },
    { source: "npm", package: "../outside" },
    null,
    1,
  ])("uses the native named-entry stub for invalid source %j", (source) => {
    expect(
      claudeMarketplaceLoadingSource(
        { name: "ordinary", source },
        { source: "github" },
        "/market",
      ),
    ).toEqual({ stringSource: false, stubbed: true });
  });
  it.each([
    "https://localhost/plugin.zip",
    "https://a.localhost./plugin.zip",
    "https://127.3.2.1/plugin.zip",
    "https://169.254.4.5/plugin.zip",
    "https://0.2.3.4/plugin.zip",
    "https://100.100.100.200/plugin.zip",
    "https://[::ffff:127.0.0.1]/plugin.zip",
    "https://[::1]/plugin.zip",
    "https://[fe80::1]/plugin.zip",
    "https://[fd00:ec2::254]/plugin.zip",
    "http://example.invalid/plugin.zip",
  ])(
    "discards archive catalog declarations rejected by the pinned source schema: %s",
    (url) => {
      expect(
        claudeMarketplaceLoadingSource(
          { name: "ordinary", source: { source: "archive", url } },
          { source: "github" },
          "/market",
        ).stubbed,
      ).toBe(true);
    },
  );
});

describe("native marketplace manifest conflicts", () => {
  it.each(["commands", "agents", "skills", "hooks", "outputStyles", "themes"])(
    "preserves JavaScript truthiness for the valid empty %s declaration",
    (key) => {
      expect(
        claudeMarketplaceManifestConflict({ strict: false, [key]: [] }, false),
      ).toBe(true);
      expect(
        claudeMarketplaceManifestConflict({ strict: true, [key]: [] }, false),
      ).toBe(false);
      expect(
        claudeMarketplaceManifestConflict({ strict: false, [key]: [] }, true),
      ).toBe(false);
    },
  );
  it("includes experimental themes, but not unrelated metadata", () => {
    expect(
      claudeMarketplaceManifestConflict(
        { strict: false, experimental: { themes: [] } },
        false,
      ),
    ).toBe(true);
    expect(
      claudeMarketplaceManifestConflict(
        { strict: false, description: "ordinary" },
        false,
      ),
    ).toBe(false);
  });
});
