import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readClaudeInstalledPluginRegistry } from "./claude-plugin-inventory.js";

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

import { capabilities } from "./__tests__/discovery-fixture.js";
describe("versioned installed plugin location observations", () => {
  it("retains all scoped records without choosing the first or exposing unrelated data", async () => {
    const value = await fixture();
    const bytes = Buffer.from(
      JSON.stringify({
        version: 2,
        plugins: {
          "ordinary@market": [
            { scope: "user", installPath: join(value.root, "user-cache") },
            {
              scope: "local",
              installPath: join(value.root, "local-cache"),
              projectPath: value.root,
              version: "1.2.3",
              unrelated: "SECRET-CANARY",
            },
          ],
        },
      }),
    );
    await writeFile(value.path, bytes);
    const registry = await readClaudeInstalledPluginRegistry(
      capabilities,
      value.path,
    );
    expect(registry.guard.digest).toBe(hash(bytes));
    expect(registry.locations).toEqual([
      {
        pluginId: "ordinary@market",
        scope: "user",
        installPath: join(value.root, "user-cache"),
        projectPath: null,
        version: null,
      },
      {
        pluginId: "ordinary@market",
        scope: "local",
        installPath: join(value.root, "local-cache"),
        projectPath: value.root,
        version: "1.2.3",
      },
    ]);
    expect(JSON.stringify(registry)).not.toContain("SECRET-CANARY");
    expect(Object.isFrozen(registry.locations)).toBe(true);
    expect(registry.locations.every(Object.isFrozen)).toBe(true);
  });

  it("keeps registry absence and an existing empty V2 registry distinct", async () => {
    const value = await fixture();
    const absent = await readClaudeInstalledPluginRegistry(
      capabilities,
      value.path,
    );
    expect(absent.guard.exists).toBe(false);
    expect(absent.locations).toEqual([]);
    await writeFile(value.path, '{"version":2,"plugins":{}}');
    const empty = await readClaudeInstalledPluginRegistry(
      capabilities,
      value.path,
    );
    expect(empty.guard.exists).toBe(true);
    expect(empty.locations).toEqual([]);
  });

  it.each([
    { version: "2", plugins: {} },
    { plugins: {} },
    { version: 2, plugins: [] },
    { version: 2, plugins: { "ordinary@market": {} } },
    { version: 2, plugins: { "": [] } },
  ])("refuses malformed registry shapes", async (registry) => {
    const value = await fixture();
    await writeFile(value.path, JSON.stringify(registry));
    await expect(
      readClaudeInstalledPluginRegistry(capabilities, value.path),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });
});

describe("native legacy cache-path conversion", () => {
  it.each([
    [
      "ordinary.plugin@market.name",
      "1.2.3/branch",
      "market-name",
      "ordinary-plugin",
      "1.2.3-branch",
    ],
    ["ordinary", "..", "unknown", "ordinary", "-"],
  ])(
    "derives legacy cache identity instead of using its recorded path",
    async (id, version, market, name, segment) => {
      const value = await fixture();
      await writeFile(
        value.path,
        JSON.stringify({
          version: 1,
          plugins: {
            [id]: {
              version,
              installedAt: "2026-10-06",
              installPath: "/obsolete/SECRET-CANARY",
            },
          },
        }),
      );
      const registry = await readClaudeInstalledPluginRegistry(
        capabilities,
        value.path,
      );
      expect(registry.locations).toEqual([
        {
          pluginId: id,
          scope: "user",
          projectPath: null,
          version,
          installPath: join(value.root, "cache", market, name, segment),
        },
      ]);
      expect(JSON.stringify(registry)).not.toContain("SECRET-CANARY");
    },
  );

  it.each([
    { version: "1.0", installPath: "/legacy" },
    { version: "1.0", installedAt: "observed" },
    { version: null, installedAt: "observed", installPath: "/legacy" },
  ])(
    "does not convert invalid legacy installation metadata",
    async (record) => {
      const value = await fixture();
      await writeFile(
        value.path,
        JSON.stringify({ version: 1, plugins: { "ordinary@market": record } }),
      );
      await expect(
        readClaudeInstalledPluginRegistry(capabilities, value.path),
      ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    },
  );
});

describe("bounded V2 plugin locations", () => {
  it.each([
    { scope: "unknown", installPath: "/cache" },
    { scope: "user", installPath: "relative" },
    { scope: "local", installPath: "/cache", projectPath: "relative" },
    { scope: "user", installPath: "/cache", version: null },
    { scope: "user", installPath: "/cache", version: "" },
    { scope: "user", installPath: "/cache", version: "\ud800" },
    { scope: "user", installPath: "/cache", version: "é".repeat(257) },
  ])("refuses ambiguous or out-of-contract location fields", async (record) => {
    const value = await fixture();
    await writeFile(
      value.path,
      JSON.stringify({ version: 2, plugins: { "ordinary@market": [record] } }),
    );
    await expect(
      readClaudeInstalledPluginRegistry(capabilities, value.path),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });

  it("bounds aggregate records even across distinct registry identities", async () => {
    const value = await fixture();
    const record = { scope: "user", installPath: join(value.root, "cache") };
    await writeFile(
      value.path,
      JSON.stringify({
        version: 2,
        plugins: { first: Array.from({ length: 128 }, () => record) },
      }),
    );
    expect(
      (await readClaudeInstalledPluginRegistry(capabilities, value.path))
        .locations,
    ).toHaveLength(128);
    await writeFile(
      value.path,
      JSON.stringify({
        version: 2,
        plugins: {
          first: Array.from({ length: 128 }, () => record),
          second: [record],
        },
      }),
    );
    await expect(
      readClaudeInstalledPluginRegistry(capabilities, value.path),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });
});
