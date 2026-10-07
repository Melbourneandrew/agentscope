import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readClaudePluginDocument,
  readClaudePluginTextDocument,
  readClaudePluginManifest,
} from "./claude-plugin-inventory.js";
import { readClaudePluginHooks } from "./claude-plugin-context.js";

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
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

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
  readClaudePluginHooks({
    installPath: root,
    manifest: await readClaudePluginManifest(root),
    marketplaceHooksDeclarationJson:
      marketplace === undefined ? null : JSON.stringify(marketplace),
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

  it.each([null, { Stop: null }, { Stop: [{ hooks: [{ type: "module" }] }] }])(
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

describe("project metadata shares the bounded authenticated document reader", () => {
  it("binds exact text without pretending non-JSON project metadata is JSON", async () => {
    const value = await fixture();
    const bytes = Buffer.from("gitdir: ../worktrees/selected\n");
    await writeFile(value.path, bytes);
    await chmod(value.path, 0o644);
    const document = await readClaudePluginTextDocument(value.path);
    expect(document).toEqual({
      guard: {
        targetPath: value.path,
        exists: true,
        digest: hash(bytes),
        mode: 0o644,
      },
      text: bytes.toString("utf8"),
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.guard)).toBe(true);
    await expect(readClaudePluginDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });

  it("preserves absence and exactly the JSON reader's consulted preimage", async () => {
    const value = await fixture();
    expect(await readClaudePluginTextDocument(value.path)).toMatchObject({
      guard: { exists: false },
      text: undefined,
    });
    await writeFile(value.path, '{"name":"ordinary"}\n');
    const text = await readClaudePluginTextDocument(value.path);
    const json = await readClaudePluginDocument(value.path);
    expect(json.guard).toEqual(text.guard);
    expect(json.value).toEqual(JSON.parse(text.text!));
  });

  it("rejects invalid UTF-8 and symlinked text just like JSON inputs", async () => {
    const value = await fixture();
    await writeFile(value.path, Buffer.from([0xff]));
    await expect(readClaudePluginTextDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    await rm(value.path);
    await symlink("elsewhere", value.path);
    await expect(readClaudePluginTextDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
});

describe("bounded consulted Claude plugin documents", () => {
  it("binds the exact document bytes and mode without inventing metadata", async () => {
    const value = await fixture();
    const bytes = Buffer.from('{"name":"ordinary-plugin"}\n');
    await writeFile(value.path, bytes, { mode: 0o600 });
    await chmod(value.path, 0o600);
    const document = await readClaudePluginDocument(value.path);
    expect(document).toEqual({
      guard: {
        targetPath: value.path,
        exists: true,
        digest: hash(bytes),
        mode: 0o600,
      },
      value: { name: "ordinary-plugin" },
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.guard)).toBe(true);
  });

  it("keeps authenticated file absence distinct from an empty registry", async () => {
    const value = await fixture();
    expect(await readClaudePluginDocument(value.path)).toEqual({
      guard: {
        targetPath: value.path,
        exists: false,
        digest: hash(new Uint8Array()),
        mode: null,
      },
      value: undefined,
    });
    await writeFile(value.path, "{}", { mode: 0o600 });
    expect((await readClaudePluginDocument(value.path)).value).toEqual({});
  });

  it.each(["malformed-SECRET-CANARY", "", Buffer.from([0xff])])(
    "rejects malformed documents without disclosing bytes or native errors",
    async (bytes) => {
      const value = await fixture();
      await writeFile(value.path, bytes);
      await expect(readClaudePluginDocument(value.path)).rejects.toThrow(
        /^cli\.harness\.plugin-inventory-unavailable$/u,
      );
    },
  );

  it("accepts the inclusive byte ceiling and rejects ceiling plus one", async () => {
    const value = await fixture();
    const bytes = Buffer.from(`{}${" ".repeat(1_048_574)}`);
    await writeFile(value.path, bytes);
    expect((await readClaudePluginDocument(value.path)).guard.digest).toBe(
      hash(bytes),
    );
    await writeFile(value.path, Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(readClaudePluginDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });

  it("refuses a final symlink and a directory", async () => {
    const value = await fixture();
    const target = join(value.root, "target.json");
    await writeFile(target, "{}");
    await symlink(target, value.path);
    await expect(readClaudePluginDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    await expect(readClaudePluginDocument(value.root)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses an actual FIFO without waiting for a writer",
    async () => {
      const value = await fixture();
      execFileSync("/usr/bin/mkfifo", [value.path]);
      await expect(readClaudePluginDocument(value.path)).rejects.toThrow(
        "cli.harness.plugin-inventory-unavailable",
      );
    },
    1_000,
  );

  it("binds file permission changes separately from unchanged bytes", async () => {
    const value = await fixture();
    await writeFile(value.path, "{}", { mode: 0o600 });
    await chmod(value.path, 0o600);
    const before = await readClaudePluginDocument(value.path);
    await chmod(value.path, 0o644);
    const after = await readClaudePluginDocument(value.path);
    expect(before.guard.digest).toBe(after.guard.digest);
    expect(before.guard.mode).toBe(0o600);
    expect(after.guard.mode).toBe(0o644);
  });

  it("refuses aliased parents and non-directory ancestors instead of claiming absence", async () => {
    const value = await fixture();
    const target = join(value.root, "target");
    const alias = join(value.root, "alias");
    await mkdir(target);
    await symlink(target, alias);
    await expect(
      readClaudePluginDocument(join(alias, "missing.json")),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    await writeFile(value.path, "{}");
    await expect(
      readClaudePluginDocument(join(value.path, "missing.json")),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    await expect(readClaudePluginDocument("relative.json")).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
});
