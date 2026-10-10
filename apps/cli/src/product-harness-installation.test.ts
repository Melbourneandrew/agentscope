import {
  chmod,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { codexHarnessDescriptor } from "@agentscope/harness-codex";
import {
  applyHarnessInstallation,
  inspectHarnessInstallation,
  type HarnessTargetInspection,
} from "@agentscope/harnesses-core";
import { beforeAll, describe, expect, it } from "vitest";
import { createProductHarnessInstallationInput } from "./product-harness-installation.js";
import {
  createProductInstallationFixtures,
  digest,
  encode,
  directoryProofInNode,
  builtProductInstallationModules,
} from "./__tests__/product-installation-fixture.js";

const { fixture, withElection } = createProductInstallationFixtures();

describe("actual private installation bundle composition", () => {
  let value: Awaited<ReturnType<typeof fixture>>;
  let installation: Awaited<
    ReturnType<typeof builtProductInstallationModules>
  >["installation"];
  beforeAll(async () => {
    value = await fixture();
    ({ installation } = await builtProductInstallationModules(value.root));
  });
  it("preserves the source Claude plan through the separately bundled factory", () => {
    const source = createProductHarnessInstallationInput(value.input);
    const built = installation.createProductHarnessInstallationInput(
      value.input,
    );
    const sourceDecision = source.planner(value.configurationInspected, []);
    expect(sourceDecision.kind).toBe("replace");
    const builtDecision = built.planner(value.configurationInspected, []);
    expect(builtDecision.kind).toBe("replace");
    expect(builtDecision).toEqual(sourceDecision);
  });
});

describe("observed discovery remains inside the existing dialect contract", () => {
  it.each([
    { version: "2.1.244" },
    { state: "unsupported" },
    { state: "absent" },
    { reason: "unavailable" },
    { harnessType: "@agentscope/harness-codex" },
    { configurationLocations: [] },
    { extra: true },
  ])(
    "rejects discovery outside the existing dialect contract (%j)",
    async (invalid) => {
      const value = await fixture();
      const observedDiscovery = {
        ...value.input.observedDiscovery,
        ...invalid,
      };
      expect(() =>
        createProductHarnessInstallationInput({
          ...value.input,
          observedDiscovery:
            observedDiscovery as typeof value.input.observedDiscovery,
        }),
      ).toThrow("cli.launcher.unsupported");
    },
  );

  it("does not invoke hostile discovery accessors or Proxy traps", async () => {
    const value = await fixture();
    let reads = 0;
    const accessor = { ...value.input.observedDiscovery };
    Object.defineProperty(accessor, "version", {
      get() {
        reads++;
        return "2.1.245";
      },
    });
    const proxy = new Proxy(value.input.observedDiscovery, {
      getOwnPropertyDescriptor() {
        reads++;
        throw new Error("fixture.trap");
      },
    });
    for (const observedDiscovery of [accessor, proxy])
      expect(() =>
        Reflect.apply(createProductHarnessInstallationInput, undefined, [
          { ...value.input, observedDiscovery },
        ]),
      ).toThrow("cli.launcher.unsupported");
    expect(reads).toBe(0);
  });
});

const absentMetadataTarget = (targetPath: string): HarnessTargetInspection => ({
  targetPath,
  exists: false,
  bytes: null,
  digest: digest(new Uint8Array()),
  mode: null,
});

describe("same-plan canonical regular-file root election", () => {
  it.each([true, false])(
    "uses the original regular-file .git callback UID before selecting (%s)",
    async (owned) => {
      const value = await fixture();
      const uid = process.geteuid?.();
      if (uid === undefined) throw new Error("fixture.posix-uid");
      const candidate = join(value.root, "project");
      const bytes = encode("native-non-gitdir-marker");
      const marker = {
        targetPath: join(candidate, ".git"),
        exists: true,
        bytes,
        digest: digest(bytes),
        mode: 0o644,
        uid: owned ? uid : uid + 1,
      };
      const directories = [candidate, join(candidate, ".claude")].map(
        (directoryPath) => ({
          directoryPath,
          exists: true,
          entries: [],
          mode: 0o755,
          uid,
        }),
      );
      const input = createProductHarnessInstallationInput({
        ...value.input,
        pluginInventory: null,
        readGuards: [...value.input.readGuards, marker],
        settingsDirectorySelections: directories.map(
          ({ directoryPath, exists }) => ({ directoryPath, exists }),
        ),
        localSettingsElection: {
          cwd: join(candidate, "nested"),
          candidate,
          realHome: "/home",
          canonical: { pluginInventory: value.input.pluginInventory },
        },
      });
      expect(input.targetPaths.indexOf(marker.targetPath)).toBeLessThan(
        input.targetPaths.indexOf(value.settingsPath),
      );
      expect(() =>
        input.planner(value.configurationInspected, directories),
      ).toThrow("cli.harness.plugin-inventory-unavailable");
      expect(input.planner(marker, directories)).toEqual({ kind: "unchanged" });
      if (owned)
        expect(
          input.planner(value.configurationInspected, directories),
        ).toMatchObject({
          kind: "replace",
        });
      else
        expect(() =>
          input.planner(value.configurationInspected, directories),
        ).toThrow("cli.harness.plugin-inventory-unavailable");
    },
  );
});

describe("same-plan canonical directory root election", () => {
  it.each([
    { owned: true, fallbackUnavailable: false, canonicalUnavailable: false },
    { owned: false, fallbackUnavailable: false, canonicalUnavailable: false },
    { owned: true, fallbackUnavailable: true, canonicalUnavailable: false },
    { owned: false, fallbackUnavailable: false, canonicalUnavailable: true },
    { owned: true, fallbackUnavailable: false, canonicalUnavailable: true },
    { owned: false, fallbackUnavailable: true, canonicalUnavailable: false },
  ])(
    "selects only the applicable held plugin context (%j)",
    async ({ owned, fallbackUnavailable, canonicalUnavailable }) => {
      const value = await fixture();
      if (value.input.harness !== "claude-code")
        throw new Error("fixture.harness");
      const baseInventory = value.input.pluginInventory;
      const uid = process.geteuid?.();
      if (uid === undefined) throw new Error("fixture.posix-uid");
      const candidate = join(value.root, "project");
      const plugin = {
        pluginId: "ordinary@market",
        installedRegistryId: "ordinary@market",
        cachePluginId: "ordinary@market",
        manifestName: null,
        manifestVersion: null,
        manifestDigest: null,
        hooksDigest: null,
        hookEvents: ["Stop"],
        directTraceExporter: null,
      };
      const context = (enabled: boolean) => ({
        ...baseInventory,
        settingsLayers: [
          ...baseInventory.settingsLayers,
          {
            scope: "local" as const,
            targetPath: join(candidate, ".claude", "settings.local.json"),
            targetExists: true,
            targetDigest: "a".repeat(64),
            enabledPlugins: { "ordinary@market": enabled },
          },
        ],
        installedPlugins: [plugin],
      });
      const directories = [
        candidate,
        join(candidate, ".git"),
        join(candidate, ".claude"),
      ].map((directoryPath) => ({
        directoryPath,
        exists: true,
        entries: [],
        mode: 0o755,
        uid: owned ? uid : uid + 1,
      }));
      const input = createProductHarnessInstallationInput({
        ...value.input,
        pluginInventory: fallbackUnavailable ? null : context(false),
        settingsDirectorySelections: directories.map(
          ({ directoryPath, exists }) => ({ directoryPath, exists }),
        ),
        localSettingsElection: {
          cwd: join(candidate, "nested"),
          candidate,
          realHome: "/home",
          canonical: {
            pluginInventory: canonicalUnavailable ? null : context(true),
          },
        },
      });
      expect(input.planner(value.inspected, directories)).toEqual({
        kind: "unchanged",
      });
      const settings = encode('{"enabledPlugins":{}}\n');
      const target = {
        targetPath: value.settingsPath,
        exists: true,
        bytes: settings,
        digest: digest(settings),
        mode: 0o600,
        uid,
      };
      if (owned ? canonicalUnavailable : fallbackUnavailable) {
        expect(() => input.planner(target, directories)).toThrow(
          "cli.harness.plugin-inventory-unavailable",
        );
        expect(await readFile(value.settingsPath)).toEqual(
          Buffer.from(settings),
        );
        return;
      }
      const decision = input.planner(target, directories);
      expect(decision.kind).toBe(owned ? "conflict" : "replace");
    },
  );
});

describe("one product installation factory selects the existing harness planner", () => {
  it.each([false, true])(
    "retains removed loading decisions across factory and election snapshots (%s)",
    async (elect) => {
      const value = await fixture();
      if (value.input.harness !== "claude-code")
        throw new Error("fixture.harness");
      const enabledPlugins = { "removed@market": true };
      const settings = encode(`${JSON.stringify({ enabledPlugins })}\n`);
      await writeFile(value.settingsPath, settings);
      const loadSelections: Record<string, string | null> = {
        "removed@market": null,
      };
      const input = createProductHarnessInstallationInput({
        ...value.input,
        ...(elect ? { cacheElections: [] } : {}),
        pluginInventory: {
          ...value.input.pluginInventory,
          settingsLayers: [
            {
              ...value.input.pluginInventory.settingsLayers[0]!,
              targetDigest: digest(settings),
              enabledPlugins,
            },
          ],
          loadSelections,
        },
      });
      // Later caller mutation must not resurrect a removed native load.
      loadSelections["removed@market"] = "removed@market";
      expect((await inspectHarnessInstallation(input)).disposition).toBe(
        "ready",
      );
      expect(await readFile(value.settingsPath)).toEqual(Buffer.from(settings));
      expect(input.planner(value.inspected)).toEqual({ kind: "unchanged" });
    },
  );

  it("preserves the default Codex target order and namespace", async () => {
    const value = await fixture();
    const planInput = createProductHarnessInstallationInput(value.common);
    expect(planInput.manifestPath).toBe(
      join(value.root, "mutations", "harness-codex-install.json"),
    );
    expect(planInput.targetPaths).toHaveLength(3);
    expect(planInput.targetPaths[2]).toBe(value.settingsPath);
    const absent = absentMetadataTarget(planInput.targetPaths[0]!);
    const metadata = planInput.planner(absent);
    expect(metadata.kind).toBe("replace");
    if (metadata.kind !== "replace") throw new Error("fixture.metadata");
    expect(JSON.parse(new TextDecoder().decode(metadata.bytes))).toMatchObject({
      harnessType: codexHarnessDescriptor.harnessType,
    });
  });

  it("uses Claude metadata, planner and read-only targets in the same Core plan", async () => {
    const value = await fixture();
    const input = createProductHarnessInstallationInput(value.input);
    expect(input.manifestPath).toBe(
      join(value.root, "mutations", "harness-claude-code-install.json"),
    );
    expect(input.targetPaths).toHaveLength(4);
    expect(input.targetPaths).toEqual([
      value.registryPath,
      value.metadataPath,
      value.launcherPath,
      value.settingsPath,
    ]);
    expect(input.planner(value.inspected)).toEqual({ kind: "unchanged" });
    const plan = await inspectHarnessInstallation(input);
    expect(plan).toMatchObject({
      disposition: "ready",
      targetCount: 4,
      changedTargetCount: 3,
    });
    expect(await readFile(value.registryPath, "utf8")).toBe(
      '{"version":2,"plugins":{}}\n',
    );
  });
});

describe("Git-root directory selection guards the existing Core plan", () => {
  it("refuses a missing .git directory before an owned metadata decision", async () => {
    const value = await fixture();
    const directoryPath = join(value.root, ".git");
    const input = createProductHarnessInstallationInput({
      ...value.input,
      settingsDirectorySelections: [{ directoryPath, exists: true }],
    });
    expect(input.directoryPaths).toEqual([directoryPath]);
    const metadata = absentMetadataTarget(value.metadataPath);
    const observed = {
      directoryPath,
      exists: true,
      mode: 0o755,
      entries: [],
    };
    expect(input.planner(metadata, [observed])).toMatchObject({
      kind: "replace",
    });
    expect(input.planner(metadata, [])).toEqual({ kind: "conflict" });
    expect(
      input.planner(metadata, [{ ...observed, exists: false, mode: null }]),
    ).toEqual({ kind: "conflict" });
  });
});

describe("plugin directory elections stay inside the existing Core plan", () => {
  it("settles a changed held file as conflict before deriving a plugin selection", async () => {
    const value = await withElection();
    // A read-only guard can settle before all held files are available;
    // the final configuration cannot select plugins without its directories.
    expect(value.input.planner(value.inspected, [])).toEqual({
      kind: "unchanged",
    });
    expect(() => value.input.planner(value.configurationInspected, [])).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    for (const target of [
      { ...value.inspected, exists: false },
      { ...value.inspected, digest: "a".repeat(64) },
      { ...value.inspected, mode: 0o644 },
    ])
      expect(value.input.planner(target, [])).toEqual({ kind: "conflict" });
    expect(await readFile(value.settingsPath, "utf8")).toBe(
      '{"enabledPlugins":{}}\n',
    );
  });
  it("checks managed directory selection before any metadata mutation and snapshots its input", async () => {
    const value = await withElection();
    if (value.sourceInput.harness !== "claude-code")
      throw new Error("fixture.harness");
    const directoryPath = "/policy/managed-settings.d";
    const entries = ["a.json"];
    const input = createProductHarnessInstallationInput({
      ...value.sourceInput,
      cacheElections: [],
      settingsDirectorySelections: [{ directoryPath, exists: true, entries }],
    });
    entries.push("later.json");
    expect(input.directoryPaths).toEqual([directoryPath]);
    const metadata = absentMetadataTarget(value.metadataPath);
    expect(input.planner(metadata, [])).toEqual({ kind: "conflict" });
    expect(
      input.planner(metadata, [
        {
          directoryPath,
          exists: true,
          mode: 0o755,
          entries: ["a.json", "later.json"],
        },
      ]),
    ).toEqual({ kind: "conflict" });
    expect(
      input.planner(metadata, [
        { directoryPath, exists: true, mode: 0o755, entries: ["a.json"] },
      ]),
    ).toMatchObject({ kind: "replace" });
  });
  it("requires complete fresh directory observations before the final configuration decision", async () => {
    const value = await withElection();
    expect(value.input.directoryPaths).toEqual(value.paths);
    const metadata = absentMetadataTarget(value.metadataPath);
    // Core completes every proposal before any target can be mutated.
    expect(value.input.planner(metadata)).toMatchObject({ kind: "replace" });
    expect(() => value.input.planner(value.configurationInspected)).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(() =>
      value.input.planner(value.configurationInspected, [
        {
          directoryPath: value.paths[0]!,
          exists: true,
          mode: 0o755,
          entries: ["node_modules"],
        },
      ]),
    ).toThrow("cli.harness.plugin-inventory-unavailable");
    expect(
      value.input.planner(
        value.configurationInspected,
        value.paths.map((directoryPath, index) => ({
          directoryPath,
          exists: true,
          mode: 0o755,
          entries: [index === 0 ? "node_modules" : "skills"],
        })),
      ),
    ).toMatchObject({ kind: "replace" });
  });
});

describe("local loading remains in the same Core plan", () => {
  it("snapshots local loading and refuses loss of its exact directory at configuration selection", async () => {
    const value = await withElection();
    if (value.sourceInput.harness !== "claude-code")
      throw new Error("fixture.harness");
    const candidate = value.sourceInput.cacheElections![0]!.candidates[0]!;
    const localPath = value.paths[1]!;
    const loading = { paths: [localPath], selectedPath: localPath, localPath };
    const input = createProductHarnessInstallationInput({
      ...value.sourceInput,
      cacheElections: [{ candidates: [{ ...candidate, loading }] }],
    });
    const directories = [candidate.installPath, localPath].map(
      (directoryPath) => ({
        directoryPath,
        exists: true,
        mode: 0o755,
        entries: [] as string[],
      }),
    );
    loading.localPath = candidate.installPath;
    loading.paths.splice(0);
    expect(
      input.planner(value.configurationInspected, directories),
    ).toMatchObject({
      kind: "replace",
    });
    directories[1]!.exists = false;
    expect(() =>
      input.planner(value.configurationInspected, directories),
    ).toThrow("plugin-inventory-unavailable");
    expect(await readFile(value.settingsPath, "utf8")).toBe(
      '{"enabledPlugins":{}}\n',
    );
  });
});

describe("alternate-version snapshots stay in the same Core plan", () => {
  it("owns alternate-version snapshots and binds every consulted root before selecting configuration", async () => {
    const value = await withElection();
    if (value.sourceInput.harness !== "claude-code")
      throw new Error("fixture.harness");
    const parentPath = join(value.root, "versions"),
      version = join(parentPath, "v9");
    const versionRoots = [{ parentPath, paths: [version] }];
    const candidate = value.sourceInput.cacheElections![0]!.candidates[0]!;
    const input = createProductHarnessInstallationInput({
      ...value.sourceInput,
      cacheElections: [
        {
          candidates: [
            {
              ...candidate,
              loading: {
                paths: [value.paths[0]!],
                selectedPath: version,
                versionRoots,
              },
            },
          ],
        },
      ],
    });
    expect(input.directoryPaths).toEqual([
      value.paths[0]!,
      parentPath,
      version,
    ]);
    versionRoots[0]!.paths.splice(0);
    versionRoots[0]!.parentPath = join(value.root, "substituted");
    const directories = [
      {
        directoryPath: value.paths[0]!,
        exists: true,
        mode: 0o755,
        entries: [],
      },
      { directoryPath: parentPath, exists: true, mode: 0o755, entries: ["v9"] },
      { directoryPath: version, exists: true, mode: 0o755, entries: ["hooks"] },
    ];
    expect(
      input.planner(value.configurationInspected, directories),
    ).toMatchObject({ kind: "replace" });
    directories[1]!.entries = ["substituted"];
    expect(() =>
      input.planner(value.configurationInspected, directories),
    ).toThrow("plugin-inventory-unavailable");
  });
});

describe("seed loading remains in the same Core plan", () => {
  it("snapshots seed loading hints and refuses a changed loading route before configuration is admitted", async () => {
    const value = await withElection();
    if (value.sourceInput.harness !== "claude-code")
      throw new Error("fixture.harness");
    const loading = { paths: [...value.paths], selectedPath: value.paths[1]! };
    const candidate = value.sourceInput.cacheElections![0]!.candidates[0]!;
    const input = createProductHarnessInstallationInput({
      ...value.sourceInput,
      cacheElections: [{ candidates: [{ ...candidate, loading }] }],
    });
    expect(input.directoryPaths).toEqual(value.paths);
    const target = value.configurationInspected;
    const observed = value.paths.map((directoryPath, index) => ({
      directoryPath,
      exists: true,
      mode: 0o755,
      entries: [index === 0 ? "node_modules" : "skills"],
    }));
    loading.paths.splice(0);
    loading.selectedPath = value.paths[0]!;
    expect(input.planner(target, observed)).toMatchObject({ kind: "replace" });
    expect(() => input.planner(target, observed.slice(0, 1))).toThrow(
      "plugin-inventory-unavailable",
    );
    observed[0]!.entries = ["new-content"];
    expect(() => input.planner(target, observed)).toThrow(
      "plugin-inventory-unavailable",
    );
  });

  it("re-evaluates supplied cache observations on every configuration callback", async () => {
    const value = await withElection();
    const directories = value.paths.map((directoryPath) => ({
      directoryPath,
      exists: true,
      mode: 0o755,
      entries: ["skills"],
    }));
    expect(
      value.input.planner(value.configurationInspected, directories),
    ).toMatchObject({
      kind: "replace",
    });
    expect(() => value.input.planner(value.configurationInspected, [])).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(() =>
      value.input.planner(
        value.configurationInspected,
        directories.map((directory) => ({
          ...directory,
          entries: ["node_modules"],
        })),
      ),
    ).toThrow("cli.harness.plugin-inventory-unavailable");
    expect(await readFile(value.settingsPath, "utf8")).toBe(
      '{"enabledPlugins":{}}\n',
    );
  });

  it("uses Core's real held observer only on its admitted runtime tuple", async () => {
    const value = await withElection();
    await mkdir(dirname(value.metadataPath), { mode: 0o700 });
    // Native DTOs belong to the normal Node realm, not Vitest's VM realm.
    // The fixed child executes no vendor and receives only this owned fixture.
    const result = directoryProofInNode(value.sourceInput);
    const admitted =
      process.versions.node.split(".")[0] === "22" &&
      ((process.platform === "darwin" && process.arch === "arm64") ||
        (process.platform === "linux" && process.arch === "x64"));
    if (!admitted) {
      expect(result).toMatchObject({
        disposition: "unavailable",
        targetCount: 0,
      });
    } else {
      expect(result).toMatchObject({
        disposition: "ready",
        targetCount: 4,
        applied: { ok: false, state: "conflict", changedTargetCount: 0 },
      });
    }
    expect(await readdir(dirname(value.metadataPath))).toEqual([]);
    expect(await readFile(value.settingsPath, "utf8")).toBe(
      '{"enabledPlugins":{}}\n',
    );
  });
});

describe("consulted plugin preimages agree before the existing Core plan is minted", () => {
  it("does not silently discard a second observation of one consulted path", async () => {
    const value = await fixture();
    if (value.input.harness !== "claude-code")
      throw new Error("fixture.harness");
    const guard = value.input.readGuards[0]!;
    for (const duplicate of [guard, { ...guard, digest: "0".repeat(64) }])
      expect(() =>
        createProductHarnessInstallationInput({
          ...value.input,
          readGuards: [guard, duplicate],
        }),
      ).toThrow("cli.harness.plugin-inventory-unavailable");
    expect(await readFile(value.registryPath, "utf8")).toBe(
      '{"version":2,"plugins":{}}\n',
    );
  });

  it.each([
    { digest: "0".repeat(64) },
    { mode: 0o700 },
    { exists: false, bytes: null, mode: null },
  ])("refuses observed guard substitution %j", async (substitution) => {
    const value = await fixture();
    const input = createProductHarnessInstallationInput(value.input);
    expect(input.planner({ ...value.inspected, ...substitution })).toEqual({
      kind: "conflict",
    });
  });

  it("rejects an actual registry change between discovery and inspection", async () => {
    const value = await fixture();
    const input = createProductHarnessInstallationInput(value.input);
    await writeFile(
      value.registryPath,
      '{"version":2,"plugins":{"changed":[]}}\n',
    );
    expect(await inspectHarnessInstallation(input)).toMatchObject({
      disposition: "conflict",
      changedTargetCount: 0,
    });
    expect(await readFile(value.settingsPath, "utf8")).toBe(
      '{"enabledPlugins":{}}\n',
    );
  });

  it("retains the consulted preimage if the caller later mutates its DTO", async () => {
    const value = await fixture();
    if (value.input.harness !== "claude-code")
      throw new Error("fixture.harness");
    const guard = { ...value.input.readGuards[0]! };
    const guards = [guard];
    const input = createProductHarnessInstallationInput({
      ...value.input,
      readGuards: guards,
    });
    guard.digest = "0".repeat(64);
    guard.targetPath = join(value.root, "substituted.json");
    guards.splice(0);
    expect(input.targetPaths).toContain(value.registryPath);
    expect(input.planner(value.inspected)).toEqual({ kind: "unchanged" });
    expect(
      input.planner({ ...value.inspected, digest: "0".repeat(64) }),
    ).toEqual({ kind: "conflict" });
  });

  it("binds an inspected registry absence without fabricating a hook digest", async () => {
    const value = await fixture();
    if (value.input.harness !== "claude-code")
      throw new Error("fixture.harness");
    const missing = join(value.root, "missing-registry.json");
    const guard = {
      targetPath: missing,
      exists: false,
      digest: digest(new Uint8Array()),
      mode: null,
    };
    const input = createProductHarnessInstallationInput({
      ...value.input,
      readGuards: [guard],
    });
    expect(input.planner({ ...guard, bytes: null })).toEqual({
      kind: "unchanged",
    });
    expect(
      input.planner({
        ...guard,
        exists: true,
        bytes: encode("new"),
        digest: digest(encode("new")),
        mode: 0o600,
      }),
    ).toEqual({ kind: "conflict" });
    expect((await inspectHarnessInstallation(input)).disposition).toBe("ready");
  });

  it("does not grant mutation authority to an unrelated target", async () => {
    const value = await fixture();
    const input = createProductHarnessInstallationInput(value.input);
    expect(
      input.planner({
        ...value.inspected,
        targetPath: join(value.root, "other"),
      }),
    ).toEqual({ kind: "unsupported" });
  });
});

describe("product consulted targets remain bound through the same Core apply", () => {
  it("applies owned Claude files without adopting a consulted registry as mutation ownership", async () => {
    const value = await fixture();
    const registryBefore = await readFile(value.registryPath);
    const input = createProductHarnessInstallationInput(value.input);
    // The product home preparation owns creation of the private launcher root;
    // this focused factory fixture must supply that existing prerequisite.
    await mkdir(dirname(value.metadataPath), { mode: 0o700 });
    const plan = await inspectHarnessInstallation(input);
    expect(plan.disposition).toBe("ready");
    expect(await applyHarnessInstallation(plan)).toMatchObject({
      ok: true,
      changedTargetCount: 3,
    });
    expect(await readFile(value.registryPath)).toEqual(registryBefore);
    const settings: unknown = JSON.parse(
      await readFile(value.settingsPath, "utf8"),
    );
    expect(settings).toMatchObject({
      enabledPlugins: {},
      hooks: {
        SessionStart: expect.any(Array) as unknown,
        Stop: expect.any(Array) as unknown,
      },
    });
    expect(await readdir(value.root)).toContain("installed_plugins.json");
    expect(await applyHarnessInstallation(plan)).toMatchObject({
      ok: false,
      state: "invalid",
    });
  });

  it.each(["bytes", "mode", "absence"])(
    "refuses actual post-inspection registry %s drift before owned mutation",
    async (kind) => {
      const value = await fixture();
      const input = createProductHarnessInstallationInput(value.input);
      const plan = await inspectHarnessInstallation(input);
      expect(plan.disposition).toBe("ready");
      if (kind === "bytes")
        await writeFile(
          value.registryPath,
          '{"version":2,"plugins":{"changed":[]}}',
        );
      else if (kind === "mode") await chmod(value.registryPath, 0o644);
      else await unlink(value.registryPath);
      const before = (await readdir(value.root)).sort();
      expect(await applyHarnessInstallation(plan)).toEqual({
        ok: false,
        state: "conflict",
        changedTargetCount: 0,
      });
      expect((await readdir(value.root)).sort()).toEqual(before);
      expect(await readFile(value.settingsPath, "utf8")).toBe(
        '{"enabledPlugins":{}}\n',
      );
      expect((await applyHarnessInstallation(plan)).state).toBe("invalid");
    },
  );
});
