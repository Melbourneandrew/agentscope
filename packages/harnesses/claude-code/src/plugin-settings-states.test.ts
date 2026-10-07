import { describe, expect, it } from "vitest";
import { createOwnedHarnessHookInvocation } from "@agentscope/harnesses-core";
import { claudeCodeDescriptor } from "./descriptor.js";
import {
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID as officialId,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  parseEnabledPlugins,
  parsePluginInventory,
  inspectPluginOverlap,
  type ClaudeCodePluginSettingsLayer as Layer,
  type ClaudeCodeInstalledPlugin,
} from "./plugin-inventory.js";
import {
  createClaudeCodeDialectAuthority,
  createClaudeCodeInstallationPlanner,
} from "./lifecycle.js";

const digest = "0".repeat(64);
const targetPath = "/isolated/.claude/settings.json";
const pluginId = "exporter@market";
const layer = (
  scope: Layer["scope"] = "user",
  path = targetPath,
  enabledPlugins: Layer["enabledPlugins"] = {},
): Layer => ({
  scope,
  targetPath: path,
  targetDigest: digest,
  targetExists: true,
  enabledPlugins,
});
const plugin: ClaudeCodeInstalledPlugin = {
  pluginId,
  installedRegistryId: pluginId,
  cachePluginId: pluginId,
  manifestName: "exporter",
  manifestVersion: null,
  manifestDigest: `sha256-${"a".repeat(64)}`,
  hooksDigest: null,
  hookEvents: ["Stop"],
  directTraceExporter: true,
};
const inventory = (
  settingsLayers: readonly Layer[],
  installedPlugins = [plugin],
) => ({ settingsLayers, installedPlugins });
const parseStates = (value: unknown, remainingBytes = 96 * 1_024) =>
  parseEnabledPlugins(value, { remainingBytes });

describe("Claude exact raw setting states", () => {
  it("preserves boolean, undefined, empty and populated string arrays", () => {
    const values = ["", "x", "x"],
      raw = { yes: true, no: false, absent: undefined, empty: [], values };
    const parsed = parseStates(raw)!;
    expect(Object.keys(parsed)).toEqual(Object.keys(raw));
    expect(Object.hasOwn(parsed, "absent")).toBe(true);
    expect(parsed).toEqual(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.values)).toBe(true);
    values.push("later");
    expect(parsed.values).toEqual(["", "x", "x"]);
  });

  it.each(
    [
      null,
      1,
      "true",
      { on: true },
      { enabled: true },
      [1],
      [true],
      [undefined],
    ].map((state) => ({ state })),
  )("rejects non-native states %j", ({ state }) => {
    expect(parseStates({ p: state })).toBeUndefined();
  });

  it("preserves exact own prototype-like keys", () => {
    const entries: [string, Layer["enabledPlugins"][string]][] = [
      ["__proto__", []],
      ["constructor", false],
      ["toString", undefined],
    ];
    const raw = Object.fromEntries(entries);
    const parsed = parseStates(raw)!;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).toEqual(Object.keys(raw));
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toEqual(
      [],
    );
    expect(Object.hasOwn(parsed, "toString")).toBe(true);
    expect(Object.hasOwn(parseStates({})!, "constructor")).toBe(false);
  });

  it("retains descriptor and proxy refusal without evaluating user code", () => {
    let calls = 0;
    const accessor = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        calls += 1;
        return "x";
      },
    });
    const proxy = new Proxy([], {
      ownKeys() {
        calls += 1;
        return [];
      },
    });
    const property = Object.defineProperty({}, "p", {
      enumerable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    for (const state of [
      accessor,
      proxy,
      new Array<unknown>(1),
      Object.assign([], { extra: "x" }),
      Object.setPrototypeOf(["x"], null) as unknown,
    ])
      expect(parseStates({ p: state })).toBeUndefined();
    for (const raw of [
      property,
      new Proxy(
        {},
        {
          getPrototypeOf() {
            calls += 1;
            return Object.prototype;
          },
        },
      ),
      { [Symbol("key")]: true },
    ])
      expect(parseStates(raw)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("keeps the existing count, string and aggregate byte limits", () => {
    expect(parseStates({ p: Array(1_025).fill("") })).toBeUndefined();
    expect(parseStates({ p: ["x".repeat(513)] })).toBeUndefined();
    expect(parseStates({ p: ["é".repeat(257)] })).toBeUndefined();
    expect(parseStates({ p: ["ab"] }, 2)).toBeUndefined();
    expect(parseStates({ p: ["ab"] }, 3)).toEqual({ p: ["ab"] });
    expect(parseStates({ p: [""] }, 1)).toBeUndefined();
    expect(parseStates({ p: [""] }, 2)).toEqual({ p: [""] });
    expect(
      parseStates(
        Object.fromEntries(
          Array.from({ length: 257 }, (_, i) => [`p${i}`, true]),
        ),
      ),
    ).toBeUndefined();
    expect(
      parseStates({ p: Array(200).fill("x".repeat(512)) }),
    ).toBeUndefined();
  });
});

describe("Claude bounded ordered raw settings cascade", () => {
  it("retains both managed main and drop-in raw preimages", () => {
    const main = layer("managed", "/managed/main.json", { [pluginId]: true });
    const dropin = layer("managed", "/managed/dropin.json", {
      "other@market": false,
    });
    const parsed = parsePluginInventory(inventory([main, dropin]))!;
    expect(parsed.settingsLayers).toEqual([main, dropin]);
    expect(inspectPluginOverlap(parsed)).toMatchObject({
      status: "conflict",
      targetPath: main.targetPath,
    });
  });

  it("uses stable per-scope order and semantic scope precedence", () => {
    const legacy = layer("local", "/project/legacy.json", { [pluginId]: true });
    const local = layer("local", "/project/local.json", { [pluginId]: false });
    const user = layer("user", targetPath, { [pluginId]: true });
    expect(inspectPluginOverlap(inventory([legacy, local, user]))).toEqual({
      status: "absent",
    });
    expect(
      inspectPluginOverlap(inventory([local, legacy, user])),
    ).toMatchObject({
      status: "conflict",
      effectiveScope: "local",
      targetPath: legacy.targetPath,
    });
  });

  it("undefined does not override an earlier defined state", () => {
    expect(
      inspectPluginOverlap(
        inventory([
          layer("user", targetPath, { [pluginId]: true }),
          layer("managed", "/managed/main.json", { [pluginId]: undefined }),
        ]),
      ),
    ).toMatchObject({ status: "conflict", effectiveScope: "user" });
    expect(
      inspectPluginOverlap(
        inventory([
          layer("managed", "/managed/main.json", { [pluginId]: undefined }),
        ]),
      ),
    ).toEqual({ status: "absent" });
  });

  it.each([{ state: [] }, { state: ["constraint"] }])(
    "arrays select entries but do not enable exporter hooks %j",
    ({ state }) => {
      expect(
        inspectPluginOverlap(
          inventory([
            layer("user", targetPath, { [pluginId]: true }),
            layer("managed", "/managed/main.json", { [pluginId]: state }),
          ]),
        ),
      ).toEqual({ status: "absent" });
    },
  );

  it("admits at most thirteen consulted rows, not unbounded scopes", () => {
    const rows = Array.from({ length: 13 }, (_, i) =>
      layer("managed", `/managed/${i}.json`),
    );
    expect(
      parsePluginInventory(inventory(rows, []))?.settingsLayers,
    ).toHaveLength(13);
    expect(
      parsePluginInventory(
        inventory([...rows, layer("managed", "/managed/14.json")], []),
      ),
    ).toBeUndefined();
    expect(
      parsePluginInventory(
        inventory([{ ...layer(), scope: "flag" } as unknown as Layer], []),
      ),
    ).toBeUndefined();
  });

  it("retains the existing 1024 effective-entry bound across repeated rows", () => {
    const rows = Array.from({ length: 4 }, (_, index) =>
      layer(
        "managed",
        `/managed/${index}.json`,
        Object.fromEntries(
          Array.from({ length: 256 }, (_, entry) => [
            `p${index}-${entry}`,
            false,
          ]),
        ),
      ),
    );
    expect(parsePluginInventory(inventory(rows, []))).toBeDefined();
    expect(
      parsePluginInventory(
        inventory(
          [...rows, layer("managed", "/managed/extra.json", { extra: false })],
          [],
        ),
      ),
    ).toBeUndefined();
  });

  it("rejects duplicate scope/path rows and contradictory physical aliases", () => {
    const raw = layer("user", targetPath, { p: ["a", "b"] });
    expect(parsePluginInventory(inventory([raw, raw], []))).toBeUndefined();
    for (const other of [
      { ...raw, scope: "project" as const, enabledPlugins: { p: ["b", "a"] } },
      { ...raw, scope: "project" as const, enabledPlugins: { p: false } },
      { ...raw, scope: "project" as const, targetDigest: "1".repeat(64) },
      { ...raw, scope: "project" as const, targetExists: false },
    ])
      expect(parsePluginInventory(inventory([raw, other], []))).toBeUndefined();
    expect(
      parsePluginInventory(inventory([raw, { ...raw, scope: "project" }], [])),
    ).toBeDefined();
  });
});

describe("Claude exact raw target and official migration", () => {
  const invocation = createOwnedHarnessHookInvocation({
    agentscopeHome: "/opt/agentscope",
    harnessType: claudeCodeDescriptor.harnessType,
    hookDeadlineMilliseconds: 2_000,
    platform: "posix",
  });
  const dialect = createClaudeCodeDialectAuthority(
    {
      harnessType: claudeCodeDescriptor.harnessType,
      state: "installed",
      reason: "compatible",
      version: "2.1.245",
      configurationLocations: [{ locationIndex: 0, present: true }],
    },
    "posix",
  );
  if (dialect === undefined) throw new Error("expected dialect");
  const decide = (
    operation: "install" | "migrate",
    rows: readonly Layer[],
    observed: unknown,
    plugins = [plugin],
  ) =>
    createClaudeCodeInstallationPlanner(
      operation,
      invocation,
      inventory(rows, plugins),
      dialect,
    )({
      targetPath,
      digest,
      exists: true,
      mode: 0o600,
      bytes: new TextEncoder().encode(
        JSON.stringify({ enabledPlugins: observed }),
      ),
    });
  const official = {
    ...plugin,
    pluginId: officialId,
    installedRegistryId: officialId,
    cachePluginId: officialId,
    manifestName: "langfuse-observability",
    manifestVersion: "1.0.0",
    manifestDigest: CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
    hooksDigest: CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
    hookEvents: ["Stop", "SessionEnd"],
  };

  it("compares exact arrays rather than flattened hook booleans", () => {
    const rows = [layer("user", targetPath, { [pluginId]: ["a"] })];
    expect(decide("install", rows, { [pluginId]: ["a"] }).kind).toBe("replace");
    for (const state of [false, [], ["b"]])
      expect(decide("install", rows, { [pluginId]: state })).toEqual({
        kind: "conflict",
      });
  });

  it("does not replace raw target agreement with a merged virtual map", () => {
    const rows = [
      layer("user", targetPath, {}),
      layer("user", "/other/settings.json", { [pluginId]: [] }),
    ];
    expect(decide("install", rows, {}).kind).toBe("replace");
    expect(decide("install", rows, { [pluginId]: [] })).toEqual({
      kind: "conflict",
    });
  });

  it("requires exact original true at the owned target for migration", () => {
    expect(
      decide(
        "migrate",
        [layer("user", targetPath, { [officialId]: true })],
        { [officialId]: true },
        [official],
      ).kind,
    ).toBe("replace-overlap");
    for (const state of [false, [], ["constraint"]]) {
      expect(
        decide(
          "migrate",
          [layer("user", targetPath, { [officialId]: state })],
          { [officialId]: state },
          [official],
        ),
      ).toEqual({ kind: "conflict" });
      expect(
        decide(
          "migrate",
          [
            layer("user", targetPath, { [officialId]: state }),
            layer("managed", "/managed/main.json", { [officialId]: true }),
          ],
          { [officialId]: state },
          [official],
        ),
      ).toEqual({ kind: "conflict" });
    }
  });
});
