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
import type { HarnessInstallationPlanInput } from "@agentscope/harnesses-core/cli-management";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupProductHarnessFixtures,
  fixture,
  testDiscoveryPolicy,
} from "./__tests__/product-harness-fixture.js";
import { createHarnessCliServices } from "./harness-services.js";
import { createProductHarnessInstallationInput } from "./product-harness-installation.js";
import { createProductHarnesses } from "./product-harnesses.js";
import {
  claudeServiceProofInNode,
  builtProductInstallationModules,
} from "./__tests__/product-installation-fixture.js";

afterEach(cleanupProductHarnessFixtures);

const nativeBytes = Buffer.from("synthetic Claude artifact never executed\n");
const nativeIdentity = {
  bytes: nativeBytes.length,
  sha256: createHash("sha256").update(nativeBytes).digest("hex"),
};

const claudeFixture = async (
  override?: string,
  absentRealHome = false,
  builtDefault = false,
) => {
  const value = await fixture();
  const bin = dirname(value.codexExecutables[0]!);
  const claudePath = join(bin, "claude");
  await writeFile(claudePath, nativeBytes, { mode: 0o755 });
  const environment: Record<string, string | undefined> = {
    PATH: bin,
    ...(override === undefined ? {} : { CLAUDE_CONFIG_DIR: override }),
  };
  const built = builtDefault
    ? await builtProductInstallationModules(dirname(value.agentscopeRoot))
    : undefined;
  const createProduct =
    built?.product.createProductHarnesses ?? createProductHarnesses;
  const input = createProduct({
    architecture: "arm64",
    codexDiscoveryPolicy: testDiscoveryPolicy,
    claudeDiscoveryPolicy: {
      version: "2.1.245",
      platforms: { "darwin-arm64": nativeIdentity },
    },
    environment,
    home: value.home,
    homeDirectory: absentRealHome
      ? join(value.vendorHome, "absent-home")
      : value.vendorHome,
    projectDirectory: value.vendorHome,
    ...(builtDefault
      ? {}
      : { installationFactory: createProductHarnessInstallationInput }),
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
    input,
    services: (
      built?.product.createHarnessCliServices ?? createHarnessCliServices
    )(input),
  };
};

const servicesWithPlan = (
  value: Awaited<ReturnType<typeof claudeFixture>>,
  transform: (plan: HarnessInstallationPlanInput) => unknown,
) =>
  createHarnessCliServices({
    ...value.input,
    adapters: (value.input.adapters ?? []).map((adapter) =>
      adapter.commandName === "claude-code"
        ? {
            ...adapter,
            createInstallationInput: async (operation) =>
              transform(
                await adapter.createInstallationInput(operation),
              ) as HarnessInstallationPlanInput,
          }
        : adapter,
    ),
  });

const serviceProofInNode = (
  value: Awaited<ReturnType<typeof claudeFixture>>,
  kind: "empty-profile" | "directory-drift",
) =>
  claudeServiceProofInNode({
    agentscopeRoot: value.agentscopeRoot,
    vendorHome: value.vendorHome,
    machineEntryPath: value.machineEntryPath,
    environment: value.environment,
    codexDiscoveryPolicy: testDiscoveryPolicy,
    claudeDiscoveryPolicy: {
      version: "2.1.245",
      platforms: { "darwin-arm64": nativeIdentity },
    },
    kind,
  });

const expectOutsideExpectedTupleUnavailable = (
  proof: ReturnType<typeof claudeServiceProofInNode>,
) => {
  expect(proof.result).toMatchObject({
    status: "partial",
    value: { applied: false, disposition: "unavailable" },
  });
  expect(proof.presented).toBe(false);
  expect(proof.presentationDisposition).toBeNull();
  expect(proof.settingsMode).toBeNull();
  expect(proof.launcherNames).toEqual([]);
};

describe("actual default private installation composition", () => {
  it("uses the actual default dynamic private factory for a compatible Claude plan", async () => {
    const value = await claudeFixture(undefined, false, true);
    const adapter = value.input.adapters?.find(
      (item) => item.commandName === "claude-code",
    );
    if (!adapter) throw new Error("fixture.adapter");
    // Synthetic native bytes are authenticated by discovery, never executed.
    // Plain held filesystem observations avoid invoking the native directory primitive.
    const plan = await adapter.createInstallationInput("install");
    const directories = await Promise.all(
      (plan.directoryPaths ?? []).map(async (directoryPath) => {
        try {
          const state = await lstat(directoryPath);
          return {
            directoryPath,
            exists: true,
            entries: await readdir(directoryPath),
            mode: state.mode & 0o777,
            uid: state.uid,
          };
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
          return {
            directoryPath,
            exists: false,
            entries: [],
            mode: null,
            uid: null,
          };
        }
      }),
    );
    const settingsPath = join(value.vendorHome, ".claude", "settings.json");
    let settingsDecision;
    for (const targetPath of plan.targetPaths) {
      let target;
      try {
        const state = await lstat(targetPath);
        const bytes = await readFile(targetPath);
        target = {
          targetPath,
          exists: true,
          bytes,
          digest: createHash("sha256").update(bytes).digest("hex"),
          mode: state.mode & 0o777,
          uid: state.uid,
        };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
        target = {
          targetPath,
          exists: false,
          bytes: null,
          digest: createHash("sha256").update("").digest("hex"),
          mode: null,
          uid: null,
        };
      }
      const decision = plan.planner(target, directories);
      if (targetPath === settingsPath) settingsDecision = decision;
    }
    expect(settingsDecision?.kind).toBe("replace");
  });
});

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
      const path = join(value.vendorHome, override, "settings.json");
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

describe("ordinary Claude explicit-profile routing", () => {
  it("does not invent a canonical real-home election when an explicit profile remains observable", async () => {
    const value = await claudeFixture(".claude", true);
    await mkdir(join(value.vendorHome, ".git"));
    await mkdir(join(value.vendorHome, ".claude"));
    await writeFile(join(value.vendorHome, ".claude", "settings.json"), "{}");
    const adapter = value.input.adapters!.find(
      (entry) => entry.commandName === "claude-code",
    )!;
    const plan = await adapter.createInstallationInput("install");
    expect(plan.targetPaths).toContain(
      join(value.vendorHome, ".claude", "settings.json"),
    );
    expect(plan.directoryPaths).toContain(join(value.vendorHome, ".git"));
    expect(await readdir(join(value.vendorHome, ".claude"))).toEqual([
      "settings.json",
    ]);
    expect((await lstat(join(value.vendorHome, ".git"))).isDirectory()).toBe(
      true,
    );
  });
});

describe("ordinary Claude CLI owned lifecycle", () => {
  it("keeps the captured empty-profile project parent and its existing mode", async () => {
    const value = await claudeFixture("");
    // Bound the fixture's repository lookup instead of depending on host temp
    // ancestry; candidate === cwd keeps the native home/cwd fallback unchanged.
    await mkdir(join(value.vendorHome, ".git"), { mode: 0o700 });
    await chmod(value.vendorHome, 0o755);
    const proof = serviceProofInNode(value, "empty-profile");
    expect(proof.gitGuarded).toBe(true);
    expect(proof.parentMode).toBe(0o755);
    expect(proof.coworkExists).toBe(false);
    if (!proof.tupleExpected) {
      expectOutsideExpectedTupleUnavailable(proof);
      return;
    }
    expect(proof.presented).toBe(true);
    expect(proof.presentationDisposition).toBe("ready");
    expect(proof.result).toMatchObject({
      status: "success",
      value: { applied: true, disposition: "committed" },
    });
    expect((await lstat(value.vendorHome)).mode & 0o777).toBe(0o755);
    expect(proof.settingsMode).toBe(0o600);
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
  it("preserves held-directory guards through the CLI service until apply", async () => {
    const value = await claudeFixture();
    await mkdir(join(value.vendorHome, ".git"), { mode: 0o700 });
    const proof = serviceProofInNode(value, "directory-drift");
    expect(proof.gitGuarded).toBe(true);
    if (!proof.tupleExpected) {
      expectOutsideExpectedTupleUnavailable(proof);
      return;
    }
    expect(proof.presented).toBe(true);
    expect(proof.presentationDisposition).toBe("ready");
    expect(proof.result).toMatchObject({
      status: "partial",
      value: { applied: false, disposition: "conflict" },
    });
    expect(proof.launcherNames).toEqual([]);
    expect(await readdir(value.home.launcherDirectory)).toEqual([]);
  });

  it.each([
    { paths: undefined, status: "failure" },
    { paths: ["relative"], status: "partial" },
    {
      paths: Array.from({ length: 17 }, (_, index) => `/oversized/${index}`),
      status: "failure",
    },
    { paths: new Array<string>(1), status: "failure" },
  ])(
    "rejects malformed directory guards without presenting a plan",
    async ({ paths, status }) => {
      const value = await claudeFixture();
      let presented = false;
      const services = servicesWithPlan(value, (plan) =>
        Object.assign({ ...plan }, { directoryPaths: paths }),
      );
      await expect(
        services.installHarness({
          apply: true,
          harness: "claude-code",
          presentPlan: () => {
            presented = true;
            return Promise.resolve();
          },
        }),
      ).resolves.toMatchObject({
        status,
        diagnostic: { code: "harness.plan-invalid" },
      });
      expect(presented).toBe(false);
      expect(await readdir(value.home.launcherDirectory)).toEqual([]);
    },
  );

  it("rejects directory-path accessors and proxies without invoking them", async () => {
    const value = await claudeFixture();
    let invoked = false;
    const getter = () => {
      invoked = true;
      throw new Error("unexpected fixture access");
    };
    const accessor = Object.defineProperty(["unused"], "0", { get: getter });
    const proxy = new Proxy(["unused"], { getPrototypeOf: getter });
    for (const paths of [accessor, proxy]) {
      const services = servicesWithPlan(value, (plan) => ({
        ...plan,
        directoryPaths: paths,
      }));
      await expect(
        services.installHarness({
          apply: false,
          harness: "claude-code",
          presentPlan: () => Promise.resolve(),
        }),
      ).resolves.toMatchObject({
        status: "failure",
        diagnostic: { code: "harness.plan-invalid" },
      });
    }
    expect(invoked).toBe(false);
  });

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
