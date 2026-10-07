import { describe, expect, it } from "vitest";

import {
  deduplicateClaudePluginLoads,
  normalizeClaudePluginRenames,
  resolveClaudePluginRename,
  selectClaudeRenameWithUnobservedPolicy,
  snapshotClaudePluginInventory,
} from "./claude-plugin-selection.js";

const select = (
  renames: unknown,
  names: readonly string[] = ["current"],
  name = "old",
) =>
  resolveClaudePluginRename(
    name,
    new Set(names),
    normalizeClaudePluginRenames(renames),
  );

const chain = (edges: number, terminal: string | null = "current") =>
  Object.fromEntries(
    Array.from({ length: edges }, (_, index) => [
      index === 0 ? "old" : `step${index}`,
      index === edges - 1 ? terminal : `step${index + 1}`,
    ]),
  );

describe("unobserved effective policy at missing-name rename", () => {
  it("uses a common original outcome without asserting absent policy", () => {
    expect(
      selectClaudeRenameWithUnobservedPolicy("old", "old", {
        source: "github",
        repo: "owner/repo",
      }),
    ).toBe("old");
    expect(
      selectClaudeRenameWithUnobservedPolicy("old", "new", {
        source: "git",
        url: "https://host\\alias/repo",
      }),
    ).toBe("old");
    expect(
      selectClaudeRenameWithUnobservedPolicy("old", null, {
        source: "git",
        url: "https://host\\alias/repo",
      }),
    ).toBe("old");
  });
  it.each(["new", null])(
    "refuses policy-dependent outcome %s rather than inventing selection",
    (renamed) => {
      for (const source of [
        { source: "github", repo: "owner/repo" },
        { source: "git", url: "https://host/repo" },
        { source: "directory", path: "/catalog" },
        { source: "git", url: 1 },
      ])
        expect(() =>
          selectClaudeRenameWithUnobservedPolicy("old", renamed, source),
        ).toThrow("cli.harness.plugin-inventory-unavailable");
    },
  );
});

describe("observed plugin inventory snapshots", () => {
  it("copies canonical loads separately from unchanged raw alias selections", () => {
    const enabledPlugins = { "old@market": true };
    const loadSelections: Record<string, string | null> = {
      "old@market": "current@market",
    };
    const hookEvents: string[] = ["Stop"];
    const input = {
      settingsLayers: [
        {
          scope: "user" as const,
          targetPath: "/fixture/settings.json",
          targetDigest: "a".repeat(64),
          targetExists: true,
          enabledPlugins,
        },
      ],
      installedPlugins: [
        {
          pluginId: "current@market",
          installedRegistryId: "current@market",
          cachePluginId: "current@market",
          manifestName: "current",
          manifestVersion: null,
          manifestDigest: null,
          hooksDigest: null,
          hookEvents,
          directTraceExporter: null,
        },
      ],
      loadSelections,
    };
    const snapshot = snapshotClaudePluginInventory(input);
    enabledPlugins["old@market"] = false;
    loadSelections["old@market"] = null;
    hookEvents.push("SessionEnd");
    expect(snapshot.settingsLayers[0]?.enabledPlugins).toEqual({
      "old@market": true,
    });
    expect(snapshot.loadSelections).toEqual({ "old@market": "current@market" });
    expect(snapshot.installedPlugins[0]).toMatchObject({
      pluginId: "current@market",
      installedRegistryId: "current@market",
      cachePluginId: "current@market",
      hookEvents: ["Stop"],
    });
    expect(Object.isFrozen(snapshot.loadSelections)).toBe(true);
    expect(Object.isFrozen(snapshot.installedPlugins[0]?.hookEvents)).toBe(
      true,
    );
  });
  it("does not introduce a projection when the original inventory omits it", () => {
    const snapshot = snapshotClaudePluginInventory({
      settingsLayers: [],
      installedPlugins: [],
    });
    expect(Object.hasOwn(snapshot, "loadSelections")).toBe(false);
  });
});

describe("pinned Claude marketplace rename selection", () => {
  it("preserves existing names before consulting a rename or removal", () => {
    expect(select({ old: "current" }, ["old", "current"])).toBe("old");
    expect(select({ old: null }, ["old"])).toBe("old");
  });

  it("uses only an existing terminal name, not an intermediate catalog entry", () => {
    expect(select({ old: "current" })).toBe("current");
    expect(
      select({ old: "intermediate", intermediate: "current" }, [
        "intermediate",
        "current",
      ]),
    ).toBe("current");
    expect(select({ old: "current", current: "missing" })).toBe("old");
  });

  it("distinguishes explicit removal from unresolved original attempts", () => {
    expect(select({ old: null })).toBeNull();
    expect(select({ old: "next", next: null })).toBeNull();
    expect(select(undefined)).toBe("old");
    expect(select({ unrelated: "current" })).toBe("old");
    expect(select({ old: "missing" })).toBe("old");
    expect(select({ old: "old" })).toBe("old");
    expect(select({ old: "next", next: "old" })).toBe("old");
  });

  it("counts the final unmapped target inside the original sixteen iterations", () => {
    expect(select(chain(15))).toBe("current");
    expect(select(chain(16))).toBe("old");
    expect(select(chain(16, null))).toBeNull();
    expect(select(chain(17, null))).toBe("old");
  });

  it.each(["", "-current", "bad name", "current@market", "../current"])(
    "does not admit an invalid renamed target %j",
    (target) => {
      expect(select({ old: target }, [target])).toBe("old");
    },
  );

  it.each([
    null,
    [],
    "current",
    { old: 1 },
    { old: "current", unrelated: false },
  ])("catches the entire malformed map %j as absent", (map) => {
    expect(select(map)).toBe("old");
  });

  it("owns a frozen map without resolving inherited or omitted prototype keys", () => {
    const input = { old: "current" };
    const owned = normalizeClaudePluginRenames(input)!;
    input.old = "missing";
    expect(Object.isFrozen(owned)).toBe(true);
    expect(resolveClaudePluginRename("old", new Set(["current"]), owned)).toBe(
      "current",
    );
    expect(
      select(JSON.parse('{"old":"__proto__","__proto__":"current"}')),
    ).toBe("old");
    expect(select({ old: "constructor", constructor: "current" })).toBe(
      "current",
    );
    expect(select({ old: "toString" }, ["current"])).toBe("old");
  });
});

describe("pinned Claude load-selection deduplication", () => {
  it.each([{ state: [] as string[] }, { state: ["constraint"] }])(
    "array entries participate in renames/removal without changing their raw state (%j)",
    ({ state }) => {
      const settings = new Map<string, boolean | readonly string[]>([
        ["old@market", state],
        ["disabled@market", false],
      ]);
      expect(
        deduplicateClaudePluginLoads(
          settings,
          new Map([
            ["old@market", "current@market"],
            ["disabled@market", "other@market"],
          ]),
        ),
      ).toEqual({
        "old@market": "current@market",
        "disabled@market": "disabled@market",
      });
      expect(
        deduplicateClaudePluginLoads(settings, new Map([["old@market", null]])),
      ).toEqual({
        "old@market": null,
        "disabled@market": "disabled@market",
      });
      expect(settings.get("old@market")).toBe(state);
    },
  );
  it.each([true, false])(
    "a later original canonical entry suppresses an alias when enabled=%j",
    (enabled) => {
      expect(
        deduplicateClaudePluginLoads(
          new Map([
            ["old@market", true],
            ["current@market", enabled],
          ]),
          new Map([["old@market", "current@market"]]),
        ),
      ).toEqual({ "old@market": null, "current@market": "current@market" });
    },
  );

  it("the first alias in original settings order owns the new target", () => {
    const settings = new Map([
      ["first@market", true],
      ["second@market", true],
    ]);
    const resolved = new Map([
      ["first@market", "current@market"],
      ["second@market", "current@market"],
    ]);
    expect(deduplicateClaudePluginLoads(settings, resolved)).toEqual({
      "first@market": "current@market",
      "second@market": null,
    });
    expect(
      deduplicateClaudePluginLoads(new Map([...settings].reverse()), resolved),
    ).toEqual({ "second@market": "current@market", "first@market": null });
  });

  it("preserves disabled and unresolved identities without changing the inputs", () => {
    const settings = new Map([
      ["disabled@market", false],
      ["unresolved@market", true],
      ["removed@market", true],
    ]);
    const resolved = new Map<string, string | null>([
      ["disabled@market", "current@market"],
      ["removed@market", null],
    ]);
    const selected = deduplicateClaudePluginLoads(settings, resolved);
    expect(selected).toEqual({
      "disabled@market": "disabled@market",
      "unresolved@market": "unresolved@market",
      "removed@market": null,
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(settings.get("disabled@market")).toBe(false);
    expect(resolved.get("disabled@market")).toBe("current@market");
    resolved.set("removed@market", "current@market");
    expect(selected["removed@market"]).toBeNull();
  });
});
