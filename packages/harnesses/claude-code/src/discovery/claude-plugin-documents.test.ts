import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readClaudePluginDocument,
  readClaudePluginManifest,
  readClaudePluginHooks,
} from "./claude-plugin-inventory.js";
import { capabilities } from "./__tests__/discovery-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-plugin-document-")),
  );
  roots.push(root);
  return { root, path: join(root, "document.json") };
};
const hookFixture = async () => {
  const { root } = await fixture();
  await mkdir(join(root, ".claude-plugin"));
  await mkdir(join(root, "hooks"));
  return root;
};
const hooks = (event: string) => ({
  [event]: [{ matcher: "", hooks: [{ type: "command", command: "unused" }] }],
});
const observe = async (root: string, marketplace: unknown = undefined) =>
  readClaudePluginHooks(capabilities, {
    installPath: root,
    manifest: await readClaudePluginManifest(capabilities, root),
    marketplaceHooksDeclarationJson:
      marketplace === undefined ? null : JSON.stringify(marketplace),
  });

describe("guarded callback preimage substitution", () => {
  it("rejects a callback-substituted raw guard rather than merging distinct custom reads", async () => {
    const root = await hookFixture();
    const defaultPath = join(root, "hooks", "hooks.json");
    const customPath = join(root, "custom.json");
    await writeFile(defaultPath, JSON.stringify({ hooks: hooks("Stop") }));
    await writeFile(customPath, JSON.stringify({ hooks: hooks("PreToolUse") }));
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "ordinary",
        hooks: "./custom.json",
      }),
    );
    const manifest = await readClaudePluginManifest(capabilities, root);
    let substituted = false;
    await expect(
      readClaudePluginHooks(
        {
          ...capabilities,
          readTextDocument: async (path) => {
            const observed = await capabilities.readTextDocument(path);
            if (path !== customPath) return observed;
            substituted = true;
            return {
              ...observed,
              guard: { ...observed.guard, targetPath: defaultPath },
            };
          },
        },
        { installPath: root, manifest, marketplaceHooksDeclarationJson: null },
      ),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    expect(substituted).toBe(true);
  });
});

describe("guarded native plugin hook composition", () => {
  it("applies marketplace assign without a manifest and key replacement with one", async () => {
    const root = await hookFixture();
    await writeFile(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { ...hooks("Stop"), ...hooks("PreToolUse") } }),
    );
    expect((await observe(root, { Stop: [] })).hookEvents).toEqual([]);
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ordinary" }),
    );
    expect((await observe(root, { Stop: [] })).hookEvents).toEqual([
      "PreToolUse",
    ]);
    expect((await observe(root, {})).hookEvents).toEqual([
      "Stop",
      "PreToolUse",
    ]);
  });
  it("does not report event execution from empty matcher/handler arrays", async () => {
    const root = await hookFixture();
    const value = await observe(root, {
      SessionStart: [],
      Stop: [{ hooks: [] }],
      PreToolUse: hooks("PreToolUse").PreToolUse,
    });
    expect(value.hookEvents).toEqual(["PreToolUse"]);
    expect(value.directTraceExporter).toBeNull();
  });
  it("keeps manifest/default absence separate from marketplace hooks", async () => {
    const root = await hookFixture();
    const value = await observe(root, hooks("Stop"));
    expect(value.hookEvents).toEqual(["Stop"]);
    expect(value.hooksDigest).toBeNull();
    expect(value.directTraceExporter).toBeNull();
    expect(value.readGuards).toMatchObject([{ exists: false, mode: null }]);
    expect(Object.isFrozen(value.hookEvents)).toBe(true);
  });

  it("unions default, custom, inline and marketplace event observations", async () => {
    const root = await hookFixture();
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "ordinary",
        hooks: ["./custom.json", hooks("PostToolUse")],
      }),
    );
    await writeFile(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({ hooks: hooks("SessionStart") }),
    );
    await writeFile(
      join(root, "custom.json"),
      JSON.stringify({ hooks: hooks("PreToolUse") }),
    );
    const value = await observe(root, hooks("Stop"));
    expect(value.hookEvents).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);
    expect(value.hooksDigest).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(value.readGuards.map((guard) => guard.targetPath)).toEqual([
      join(root, "hooks", "hooks.json"),
      join(root, "custom.json"),
    ]);
    expect(value.directTraceExporter).toBeNull();
  });

  it.each([
    null,
    { Stop: null },
    { Stop: [{ hooks: [{ type: "module" }] }] },
    { Stop: [{ matcher: 1, hooks: [] }] },
    { Stop: [{ hooks: null }] },
  ])(
    "refuses unresolved marketplace hooks %j instead of empty events",
    async (declaration) => {
      const root = await hookFixture();
      await expect(observe(root, declaration)).rejects.toThrow();
    },
  );

  it.each(["./never-read.json", [], ["./never-read.json"]])(
    "preserves real cache hooks when native ignores catalog path/array %j",
    async (declaration) => {
      const root = await hookFixture();
      await writeFile(
        join(root, "hooks", "hooks.json"),
        JSON.stringify({ hooks: hooks("Stop") }),
      );
      const value = await observe(root, declaration);
      expect(value.hookEvents).toEqual(["Stop"]);
      expect(value.hooksDigest).not.toBeNull();
      expect(value.readGuards.map((guard) => guard.targetPath)).toEqual([
        join(root, "hooks", "hooks.json"),
      ]);
      expect(value.directTraceExporter).toBeNull();
    },
  );

  it.each([
    "../outside.json",
    "/outside.json",
    "hooks/hooks.json",
    "missing.json",
  ])("refuses escaped, duplicate or missing manifest file %s", async (path) => {
    const root = await hookFixture();
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ordinary", hooks: path }),
    );
    await expect(observe(root)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
});
describe("native JSON decoding over bounded read observations", () => {
  it.each(["malformed-SECRET-CANARY", "", "gitdir: ../worktrees/selected\n"])(
    "rejects non-JSON observation without content disclosure",
    async (text) => {
      const value = await fixture();
      await writeFile(value.path, text);
      await expect(
        readClaudePluginDocument(capabilities, value.path),
      ).rejects.toThrow(/^cli\.harness\.plugin-inventory-unavailable$/u);
    },
  );
  it("preserves guarded absence and decoded empty versus named records", async () => {
    const value = await fixture();
    expect(
      await readClaudePluginDocument(capabilities, value.path),
    ).toMatchObject({ guard: { exists: false }, value: undefined });
    await writeFile(value.path, "{}");
    expect(
      (await readClaudePluginDocument(capabilities, value.path)).value,
    ).toEqual({});
    await writeFile(value.path, JSON.stringify({ name: "ordinary-plugin" }));
    expect(
      (await readClaudePluginDocument(capabilities, value.path)).value,
    ).toEqual({ name: "ordinary-plugin" });
  });
});
