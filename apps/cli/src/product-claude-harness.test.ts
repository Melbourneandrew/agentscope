import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupProductHarnessFixtures,
  fixture,
  testDiscoveryPolicy,
} from "./__tests__/product-harness-fixture.js";
import { createHarnessCliServices } from "./harness-services.js";
import { claudeUserConfiguration } from "./claude-discovery.js";
import { createProductHarnessInstallationInput } from "./product-harness-installation.js";
import { createProductHarnesses } from "./product-harnesses.js";

afterEach(cleanupProductHarnessFixtures);

const nativeBytes = Buffer.from("synthetic Claude artifact never executed\n");
const nativeIdentity = {
  bytes: nativeBytes.length,
  sha256: createHash("sha256").update(nativeBytes).digest("hex"),
};

const claudeFixture = async (override?: string) => {
  const value = await fixture();
  const bin = dirname(value.codexExecutables[0]!);
  const claudePath = join(bin, "claude");
  await writeFile(claudePath, nativeBytes, { mode: 0o755 });
  const environment: Record<string, string | undefined> = {
    PATH: bin,
    ...(override === undefined ? {} : { CLAUDE_CONFIG_DIR: override }),
  };
  const input = createProductHarnesses({
    architecture: "arm64",
    codexDiscoveryPolicy: testDiscoveryPolicy,
    claudeDiscoveryPolicy: {
      version: "2.1.245",
      platforms: { "darwin-arm64": nativeIdentity },
    },
    environment,
    home: value.home,
    homeDirectory: value.vendorHome,
    projectDirectory: value.vendorHome,
    installationFactory: createProductHarnessInstallationInput,
    machineEntryPath: value.machineEntryPath,
    nodeExecutable: process.execPath,
    platform: "darwin",
    readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
    releaseIdentity: "0.1.0",
  });
  return {
    ...value,
    claudePath,
    environment,
    services: createHarnessCliServices(input),
  };
};

describe("ordinary CLI registry exposes Codex and Claude independently", () => {
  it("discovers both exact artifacts and only Claude's default configuration", async () => {
    const value = await claudeFixture();
    await mkdir(join(value.vendorHome, ".claude"));
    await writeFile(join(value.vendorHome, ".claude", "settings.json"), "{}");
    await expect(value.services.listHarnesses()).resolves.toMatchObject({
      status: "success",
      value: {
        harnesses: [
          { harness: "codex", reason: "compatible", version: "0.149.1" },
          {
            harness: "claude-code",
            harnessType: "@agentscope/harness-claude-code",
            reason: "compatible",
            state: "installed",
            version: "2.1.245",
            configurationLocationCount: 1,
            configurationPresentCount: 1,
          },
        ],
      },
    });
  });

  it("does not confuse a substituted Claude executable with a Codex failure", async () => {
    const value = await claudeFixture();
    await writeFile(value.claudePath, "substituted");
    await expect(value.services.listHarnesses()).resolves.toMatchObject({
      value: {
        harnesses: [
          { harness: "codex", reason: "compatible" },
          {
            harness: "claude-code",
            reason: "version-unavailable",
            state: "indeterminate",
          },
        ],
      },
    });
  });

  it.each(["", "selected-claude", "~/literal-root"])(
    "observes the selected profile rather than the default with override %s",
    async (override) => {
      const value = await claudeFixture(override);
      const path = claudeUserConfiguration(value.vendorHome, value.vendorHome, {
        CLAUDE_CONFIG_DIR: override,
      }).settingsPath;
      await mkdir(join(value.vendorHome, ".claude"));
      await writeFile(join(value.vendorHome, ".claude", "settings.json"), "{}");
      await expect(value.services.listHarnesses()).resolves.toMatchObject({
        value: {
          harnesses: [
            { harness: "codex", reason: "compatible" },
            {
              harness: "claude-code",
              reason: "compatible",
              configurationPresentCount: 0,
            },
          ],
        },
      });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{}");
      await expect(value.services.listHarnesses()).resolves.toMatchObject({
        value: {
          harnesses: [
            { harness: "codex", reason: "compatible" },
            {
              harness: "claude-code",
              reason: "compatible",
              configurationPresentCount: 1,
            },
          ],
        },
      });
    },
  );
});

describe("ordinary Claude CLI owned lifecycle", () => {
  it("keeps the captured empty-profile project parent and its existing mode", async () => {
    const value = await claudeFixture("");
    await chmod(value.vendorHome, 0o755);
    const settings = join(value.vendorHome, "settings.json");
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "claude-code",
        presentPlan: () => {
          value.environment.CLAUDE_CONFIG_DIR = "/foreign-profile";
          value.environment.CLAUDE_CODE_USE_COWORK_PLUGINS = "1";
          value.environment.CLAUDE_CODE_PLUGIN_CACHE_DIR = "/foreign-cache";
          return Promise.resolve();
        },
      }),
    ).resolves.toMatchObject({ status: "success", value: { applied: true } });
    expect((await lstat(value.vendorHome)).mode & 0o777).toBe(0o755);
    expect((await lstat(settings)).mode & 0o777).toBe(0o600);
    await expect(
      lstat(join(value.vendorHome, "cowork_settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("installs idempotently, diagnoses conflicts and removes only owned state", async () => {
    const value = await claudeFixture();
    const directory = join(value.vendorHome, ".claude");
    const settingsPath = join(directory, "settings.json");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(settingsPath, '{"theme":"dark"}\n', { mode: 0o600 });
    const presentPlan = () => Promise.resolve();
    const install = (apply: boolean) =>
      value.services.installHarness({
        apply,
        harness: "claude-code",
        presentPlan,
      });
    await expect(install(false)).resolves.toMatchObject({
      status: "success",
      value: { applied: false, disposition: "ready" },
    });
    expect(await readFile(settingsPath, "utf8")).toBe('{"theme":"dark"}\n');
    expect(await readdir(value.home.launcherDirectory)).toEqual([]);
    await expect(install(true)).resolves.toMatchObject({
      status: "success",
      value: { applied: true, changedTargetCount: 3, disposition: "committed" },
    });
    const names = await readdir(value.home.launcherDirectory);
    const launcher = names.find(
      (name) =>
        name.startsWith("agentscope-hook-v1-") && !name.endsWith(".json"),
    );
    expect(launcher).toBeDefined();
    const launcherPath = join(value.home.launcherDirectory, launcher!);
    expect((await lstat(launcherPath)).mode & 0o777).toBe(0o700);
    const installed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      theme: string;
      hooks: Record<string, unknown>;
    };
    expect(installed.theme).toBe("dark");
    expect(Object.keys(installed.hooks).sort()).toEqual(
      ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].sort(),
    );
    expect(JSON.stringify(installed.hooks)).toContain(launcherPath);
    await expect(install(true)).resolves.toMatchObject({
      status: "success",
      value: {
        applied: false,
        changedTargetCount: 0,
        disposition: "unchanged",
      },
    });
    await expect(
      value.services.statusHarness({ harness: "claude-code" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { installation: "unchanged" },
    });
    await chmod(launcherPath, 0o600);
    await expect(
      value.services.statusHarness({ harness: "claude-code" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { installation: "conflict" },
    });
    await chmod(launcherPath, 0o700);
    await expect(
      value.services.uninstallHarness({
        apply: true,
        harness: "claude-code",
        presentPlan,
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      hooks: {},
      theme: "dark",
    });
    await expect(lstat(launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${launcherPath}.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      value.services.statusHarness({ harness: "claude-code" }),
    ).resolves.toMatchObject({
      status: "success",
      value: { installation: "ready" },
    });
  });
});

describe("ordinary Claude CLI presentation preimages", () => {
  it("does not overwrite settings changed after plan presentation", async () => {
    const value = await claudeFixture();
    const directory = join(value.vendorHome, ".claude");
    const settingsPath = join(directory, "settings.json");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(settingsPath, '{"theme":"dark"}\n', { mode: 0o600 });
    const changed =
      '{"theme":"light","enabledPlugins":{"other@market":false}}\n';
    await expect(
      value.services.installHarness({
        apply: true,
        harness: "claude-code",
        presentPlan: () => writeFile(settingsPath, changed, { mode: 0o600 }),
      }),
    ).resolves.toMatchObject({
      status: "partial",
      value: { applied: false },
    });
    expect(await readFile(settingsPath, "utf8")).toBe(changed);
    expect(
      (await readdir(value.home.launcherDirectory)).filter((name) =>
        name.startsWith("agentscope-hook-v1-"),
      ),
    ).toEqual([]);
  });
});
