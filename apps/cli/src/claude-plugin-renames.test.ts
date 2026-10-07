import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createClaudeContextFixtures,
  hooks,
} from "./__tests__/claude-plugin-context-fixture.js";

const { cachedContext } = createClaudeContextFixtures();

const renamedFixture = async (
  enabledPlugins: Readonly<Record<string, boolean>>,
  renames: Readonly<Record<string, string | null>>,
) => {
  const fixture = await cachedContext();
  const settingsPath = join(fixture.home, ".claude", "settings.json");
  await writeFile(settingsPath, JSON.stringify({ enabledPlugins }));
  await writeFile(
    join(fixture.catalog, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "market",
      renames,
      plugins: [
        { name: "ordinary", source: "./ordinary", hooks: hooks("Stop") },
      ],
    }),
  );
  return { ...fixture, settingsPath };
};

describe("catalog rename composition before real cache election", () => {
  it("does not invent a canonical load from an unobserved policy-dependent alias", async () => {
    const fixture = await renamedFixture(
      { "old@market": true },
      { old: "ordinary" },
    );
    const before = await readFile(fixture.settingsPath, "utf8");
    await expect(fixture.read()).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(before);
  });

  it.each([true, false])(
    "canonical occupancy %s does not authenticate the policy-dependent alias decision",
    async (canonical) => {
      const fixture = await renamedFixture(
        { "old@market": true, "ordinary@market": canonical },
        { old: "ordinary" },
      );
      const before = await readFile(fixture.settingsPath, "utf8");
      await expect(fixture.read()).rejects.toThrow(
        "cli.harness.plugin-inventory-unavailable",
      );
      expect(await readFile(fixture.settingsPath, "utf8")).toBe(before);
    },
  );

  it("does not fabricate an empty inventory from policy-dependent removal", async () => {
    const fixture = await renamedFixture({ "old@market": true }, { old: null });
    const before = await readFile(fixture.settingsPath, "utf8");
    await expect(fixture.read()).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(before);
  });

  it("keeps an existing catalog name ahead of a rename declaration", async () => {
    const fixture = await renamedFixture(
      { "ordinary@market": true },
      { ordinary: null },
    );
    const context = await fixture.read();
    expect(context.pluginInventory.installedPlugins).toHaveLength(1);
    expect(Object.hasOwn(context.pluginInventory, "loadSelections")).toBe(
      false,
    );
  });

  it("does not consult a catalog for a disabled original setting", async () => {
    const fixture = await renamedFixture(
      { "old@market": false },
      { old: "ordinary" },
    );
    const context = await fixture.read();
    expect(context.pluginInventory.installedPlugins).toEqual([]);
    expect(Object.hasOwn(context.pluginInventory, "loadSelections")).toBe(
      false,
    );
    expect(
      context.readGuards.some((guard) =>
        guard.targetPath.startsWith(fixture.catalog),
      ),
    ).toBe(false);
  });

  it("does not use the canonical cache for an unresolved rename", async () => {
    const fixture = await renamedFixture(
      { "old@market": true },
      { old: "missing" },
    );
    await expect(fixture.read()).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
});
