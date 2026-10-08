import { describe, expect, it } from "vitest";
import {
  normalizeClaudeMarketplaceAliases,
  parseClaudeEnabledPluginsField,
  parseClaudeEnabledPluginsSettingsSource,
  projectClaudeParsedSettings,
} from "./claude-settings-projection.js";
import { catalogMarketplaceSource } from "./claude-catalog-entry.js";

describe("relevant ordinary-source rejection before plugin projection", () => {
  it.each([
    "strictKnownMarketplaces",
    "allowedMarketplaces",
    "blockedMarketplaces",
  ])(
    "drops an ordinary source, not managed enabledPlugins, for invalid %s",
    (field) => {
      const raw = { enabledPlugins: { "ordinary@market": true }, [field]: 17 };
      expect(parseClaudeEnabledPluginsSettingsSource(raw, false)).toEqual({
        kind: "source-ignored",
      });
      expect(parseClaudeEnabledPluginsSettingsSource(raw, true)).toEqual({
        kind: "parsed",
        enabledPlugins: raw.enabledPlugins,
      });
    },
  );
  it.each([
    { strictKnownMarketplaces: [], allowedMarketplaces: 17 },
    { strictKnownMarketplaces: null, allowedMarketplaces: [] },
    { allowedMarketplaces: [] },
    { extraKnownMarketplaces: 17 },
    { additionalMarketplaces: null },
  ])(
    "preserves alias precedence and separate declaration salvage for %j",
    (fields) => {
      expect(
        parseClaudeEnabledPluginsSettingsSource(
          { ...fields, enabledPlugins: { p: true } },
          false,
        ),
      ).toEqual({
        kind: "parsed",
        enabledPlugins: { p: true },
      });
    },
  );
  it.each([
    { strictKnownMarketplaces: 17, allowedMarketplaces: [] },
    { strictKnownMarketplaces: null },
    { blockedMarketplaces: [{ source: "future" }] },
    { blockedMarketplaces: [{ source: "npm", package: "a..b" }] },
    {
      strictKnownMarketplaces: [
        { source: "settings", name: "builtin", plugins: [] },
      ],
    },
  ])(
    "does not rescue an invalid canonical or source entry from %j",
    (fields) => {
      expect(
        parseClaudeEnabledPluginsSettingsSource(
          { ...fields, enabledPlugins: { p: true } },
          false,
        ),
      ).toEqual({ kind: "source-ignored" });
    },
  );
});

describe("pinned marketplace source predicates are parsing, not acquisition", () => {
  it.each([
    {
      source: "url",
      url: "ftp://example.test/catalog.json",
      headersHelper: "",
    },
    { source: "github", repo: "", sparsePaths: [""], skipLfs: false },
    { source: "git", url: "not-a-url", ref: "" },
    { source: "npm", package: "@scope/market" },
    { source: "file", path: "" },
    { source: "directory", path: "" },
    { source: "skills-dir" },
    { source: "hostPattern", hostPattern: "(" },
    { source: "pathPattern", pathPattern: "(" },
    {
      source: "settings",
      name: "ordinary",
      plugins: [],
      owner: { name: "owner" },
    },
  ])("preserves the actual constructor acceptance for %j", (source) => {
    expect(catalogMarketplaceSource.safeParse(source).success).toBe(true);
    expect(
      parseClaudeEnabledPluginsSettingsSource(
        { blockedMarketplaces: [source], enabledPlugins: { p: true } },
        false,
      ),
    ).toEqual({ kind: "parsed", enabledPlugins: { p: true } });
  });
});

describe("pinned malformed marketplace source rejection", () => {
  it.each([
    { source: "url", url: "invalid" },
    { source: "url", url: "https://example.test", headers: { key: 17 } },
    { source: "url", url: "https://example.test", headersHelper: "a    b" },
    { source: "github", repo: "owner/repo", skipLfs: "true" },
    { source: "npm", package: "UPPER" },
    { source: "settings", name: "official-claude", plugins: [] },
    { source: "settings", name: "claude-community", plugins: [] },
    {
      source: "settings",
      name: "ordinary",
      plugins: [{ name: "p", source: "./relative" }],
    },
    { source: "settings", name: "ordinary", plugins: [], owner: { name: "" } },
  ])("rejects actual malformed constructor inputs for %j", (source) => {
    expect(catalogMarketplaceSource.safeParse(source).success).toBe(false);
  });
});

describe("pinned enabledPlugins field parsing", () => {
  it.each([false, true])("preserves raw states for managed=%s", (managed) => {
    const array = ["a", "a", "b"];
    const raw = { disabled: false, enabled: true, list: array, empty: [] };
    const result = parseClaudeEnabledPluginsField(raw, managed);
    expect(result).toEqual({ kind: "parsed", enabledPlugins: raw });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== "parsed") throw new Error("expected parsed field");
    expect(Object.isFrozen(result.enabledPlugins)).toBe(true);
    expect(Object.isFrozen(result.enabledPlugins?.list)).toBe(true);
    array.push("later");
    expect(result.enabledPlugins?.list).toEqual(["a", "a", "b"]);
  });

  it.each([null, 17, [], { good: true, bad: 17 }, { bad: ["a", 17] }])(
    "rejects the whole ordinary source or managed field for %j",
    (field) => {
      expect(parseClaudeEnabledPluginsField(field, false)).toEqual({
        kind: "source-ignored",
      });
      expect(parseClaudeEnabledPluginsField(field, true)).toEqual({
        kind: "field-ignored",
      });
    },
  );

  it("distinguishes absent fields, empty maps, and parsed undefined entries", () => {
    expect(parseClaudeEnabledPluginsField(undefined, false)).toEqual({
      kind: "parsed",
    });
    expect(parseClaudeEnabledPluginsField({}, false)).toEqual({
      kind: "parsed",
      enabledPlugins: {},
    });
    const result = parseClaudeEnabledPluginsField({ p: undefined }, false);
    expect(result).toEqual({
      kind: "parsed",
      enabledPlugins: { p: undefined },
    });
    if (result.kind !== "parsed") throw new Error("expected parsed field");
    expect(Object.hasOwn(result.enabledPlugins!, "p")).toBe(true);
  });
});

describe("parsed Claude relevant settings projection", () => {
  it("normalizes aliases without changing raw fields", () => {
    const raw = {
      additionalMarketplaces: { m: { source: "file" } },
      allowedMarketplaces: [],
    };
    const result = normalizeClaudeMarketplaceAliases(raw);
    expect(result).toEqual({
      extraKnownMarketplaces: raw.additionalMarketplaces,
      strictKnownMarketplaces: [],
    });
    expect(raw).toHaveProperty("additionalMarketplaces");
    expect(result).not.toHaveProperty("additionalMarketplaces");
  });

  it("keeps present non-null canonical empty values over aliases", () => {
    expect(
      normalizeClaudeMarketplaceAliases({
        extraKnownMarketplaces: {},
        additionalMarketplaces: { ignored: 1 },
        strictKnownMarketplaces: [],
        allowedMarketplaces: [1],
      }),
    ).toEqual({ extraKnownMarketplaces: {}, strictKnownMarketplaces: [] });
  });

  it("replaces null canonical fields with aliases", () => {
    expect(
      normalizeClaudeMarketplaceAliases({
        extraKnownMarketplaces: null,
        additionalMarketplaces: { m: 1 },
        strictKnownMarketplaces: null,
        allowedMarketplaces: [1],
      }),
    ).toEqual({
      extraKnownMarketplaces: { m: 1 },
      strictKnownMarketplaces: [1],
    });
  });

  it("does not substitute aliases for present undefined canonical fields", () => {
    const raw = {
      extraKnownMarketplaces: undefined,
      additionalMarketplaces: { ignored: 1 },
      strictKnownMarketplaces: undefined,
      allowedMarketplaces: [1],
    };
    expect(normalizeClaudeMarketplaceAliases(raw)).toEqual({});
    expect(Object.hasOwn(raw, "extraKnownMarketplaces")).toBe(true);
    expect(Object.hasOwn(raw, "strictKnownMarketplaces")).toBe(true);
    expect(raw.additionalMarketplaces).toEqual({ ignored: 1 });
    expect(raw.allowedMarketplaces).toEqual([1]);
  });

  it("preserves exact original IDs and boolean layer precedence", () => {
    expect(
      projectClaudeParsedSettings([
        { enabledPlugins: { "old@m": false, "canonical@m": true } },
        { enabledPlugins: { "old@m": true } },
      ]).enabledPlugins,
    ).toEqual({ "old@m": true, "canonical@m": true });
  });

  it("unions arrays in low-to-high order and replaces boolean transitions", () => {
    expect(
      projectClaudeParsedSettings([
        { enabledPlugins: { p: ["a", "a"], q: true } },
        { enabledPlugins: { p: ["b", "a"], q: ["x"] } },
        { enabledPlugins: { q: false } },
      ]).enabledPlugins,
    ).toEqual({ p: ["a", "b"], q: false });
  });

  it("replaces whole marketplace declarations, not nested source fields", () => {
    expect(
      projectClaudeParsedSettings([
        {
          extraKnownMarketplaces: {
            m: { source: { source: "github", repo: "a/b" }, autoUpdate: true },
          },
        },
        {
          additionalMarketplaces: {
            m: { source: { source: "file", path: "x" } },
          },
        },
      ]).extraKnownMarketplaces,
    ).toEqual({ m: { source: { source: "file", path: "x" } } });
  });

  it("deduplicates policy lists by identity, not structural equality", () => {
    const first = { source: "file", path: "x" },
      second = { source: "file", path: "x" };
    expect(
      projectClaudeParsedSettings([
        { strictKnownMarketplaces: [first], blockedMarketplaces: [first] },
        { allowedMarketplaces: [first, second], blockedMarketplaces: [second] },
      ]),
    ).toMatchObject({
      strictKnownMarketplaces: [first, second],
      blockedMarketplaces: [first, second],
    });
  });

  it("returns owned frozen containers without mutating parsed layers", () => {
    const values = ["a"],
      raw = { enabledPlugins: { p: values } };
    const result = projectClaudeParsedSettings([raw]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.enabledPlugins)).toBe(true);
    expect(Object.isFrozen(result.enabledPlugins.p)).toBe(true);
    values.push("b");
    expect(result.enabledPlugins.p).toEqual(["a"]);
  });
});

describe("Claude parsed undefined state", () => {
  it("skips undefined without erasing earlier defined values or inventing an entry", () => {
    const raw = { p: undefined, q: undefined };
    expect(
      projectClaudeParsedSettings([
        { enabledPlugins: { p: ["a"] } },
        { enabledPlugins: raw },
      ]).enabledPlugins,
    ).toEqual({ p: ["a"] });
    expect(Object.hasOwn(raw, "q")).toBe(true);
    expect(
      projectClaudeParsedSettings([{ enabledPlugins: raw }]).enabledPlugins,
    ).toEqual({});
  });
});

describe("Claude projection exact own keys", () => {
  it("preserves prototype-named own keys as plain-record data", () => {
    const keys = ["__proto__", "constructor", "toString"];
    const first = Object.fromEntries(keys.map((key) => [key, ["old"]]));
    const second = Object.fromEntries(keys.map((key) => [key, ["new"]]));
    const result = projectClaudeParsedSettings([
      { enabledPlugins: first },
      { enabledPlugins: second },
    ]).enabledPlugins;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result)).toEqual(keys);
    for (const key of keys) {
      expect(Object.hasOwn(result, key)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(result, key)?.value).toEqual([
        "old",
        "new",
      ]);
    }
  });

  it("does not invent absent inherited keys or merge their prototype values", () => {
    const empty = projectClaudeParsedSettings([{ enabledPlugins: {} }]);
    for (const key of ["__proto__", "constructor", "toString"])
      expect(Object.hasOwn(empty.enabledPlugins, key)).toBe(false);
    const result = projectClaudeParsedSettings([
      { enabledPlugins: {} },
      { enabledPlugins: Object.fromEntries([["__proto__", false]]) },
    ]).enabledPlugins;
    expect(Object.keys(result)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe(
      false,
    );
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
