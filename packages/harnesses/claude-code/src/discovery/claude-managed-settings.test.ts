import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  HarnessDirectoryInspection,
  HarnessTargetInspection,
} from "@agentscope/harnesses-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverClaudeManagedSettings,
  claudeSettingsDirectoriesAgree,
  selectClaudeCanonicalLocalRoot,
  selectClaudeCanonicalLocalRootFromHeld,
  readClaudeScopedSettings,
  claudeManagedSettingsPath,
  mergeClaudeSettingsDirectorySelections,
} from "./claude-managed-settings.js";

import {
  claudePlaintextCredentialPath,
  captureClaudeEnvironment,
} from "./claude-discovery.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-managed-settings-")),
  );
  roots.push(root);
  return {
    root,
    main: join(root, "managed-settings.json"),
    directory: join(root, "managed-settings.d"),
  };
};

describe("managed source paths and immutable directory observations", () => {
  it("uses exact platform paths rather than a portable managed-file fiction", () => {
    expect(claudeManagedSettingsPath("darwin")).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
    expect(claudeManagedSettingsPath("linux")).toBe(
      "/etc/claude-code/managed-settings.json",
    );
    expect(() => claudeManagedSettingsPath("win32")).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
  it("rejects contradictory observations of the same consulted directory", () => {
    const present = { directoryPath: "/managed", exists: true, entries: [] };
    expect(() =>
      mergeClaudeSettingsDirectorySelections([
        [present],
        [{ ...present, exists: false }],
      ]),
    ).toThrow("cli.harness.plugin-inventory-unavailable");
    expect(() =>
      mergeClaudeSettingsDirectorySelections([
        [present],
        [{ ...present, entries: ["later.json"] }],
      ]),
    ).toThrow("cli.harness.plugin-inventory-unavailable");
  });
  it("refuses directory metadata drift after collecting names", async () => {
    const { main, directory } = await fixture();
    await mkdir(directory);
    let inspections = 0;
    const changed = {
      ...capabilities,
      inspectPath: async (path: string) => {
        const observed = await capabilities.inspectPath(path);
        if (path !== directory) return observed;
        inspections += 1;
        return inspections === 1
          ? observed
          : {
              ...observed,
              mtimeMs: observed.mtimeMs + 1,
            };
      },
    };
    await expect(discoverClaudeManagedSettings(changed, main)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(inspections).toBe(2);
  });
});

describe("canonical settings election consumes held Core observations", () => {
  const directory = (directoryPath: string, uid: number | null = 0) => ({
    directoryPath,
    exists: true,
    entries: [],
    mode: 0o755,
    uid,
  });
  const select = (
    directories: readonly HarnessDirectoryInspection[],
    files: readonly HarnessTargetInspection[] = [],
  ) =>
    selectClaudeCanonicalLocalRootFromHeld(
      "/work/nested",
      "/work",
      "/home",
      0,
      { directories, files },
    );
  it("accepts a held directory marker and zero UID", () => {
    expect(
      select([
        directory("/work"),
        directory("/work/.git"),
        directory("/work/.claude"),
      ]),
    ).toBe("/work");
  });
  it("accepts a held file marker without fabricating directory ownership", () => {
    const bytes = new TextEncoder().encode("gitdir: /private/gitdir");
    const marker = {
      targetPath: "/work/.git",
      exists: true,
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      mode: 0o644,
      uid: 0,
    };
    const directories = [directory("/work"), directory("/work/.claude")];
    expect(select(directories, [marker])).toBe("/work");
    expect(select(directories, [{ ...marker, uid: 1 }])).toBe("/work/nested");
    expect(select(directories)).toBe("/work/nested");
    expect(select([...directories, directory("/work/.git")], [marker])).toBe(
      "/work/nested",
    );
  });
  it("accepts an explicitly held absent .claude directory", () => {
    expect(
      select([
        directory("/work"),
        directory("/work/.git"),
        {
          directoryPath: "/work/.claude",
          exists: false,
          entries: [],
          mode: null,
          uid: null,
        },
      ]),
    ).toBe("/work");
  });
  it("refuses ambiguous or missing held identities", () => {
    const root = directory("/work");
    const git = directory("/work/.git");
    const claude = directory("/work/.claude");
    for (const observations of [
      [root, git],
      [root, git, claude, root],
      [root, git, git, claude],
      [directory("/work", null), git, claude],
    ])
      expect(select(observations)).toBe("/work/nested");
  });
});

describe("distinct project and selected local settings scopes", () => {
  it.each([false, true])(
    "keeps project settings at original cwd; canonical local root=%s",
    async (canonical) => {
      const { root, main } = await fixture();
      const cwd = join(root, "project", "nested");
      const localRoot = canonical ? join(root, "project") : cwd;
      const user = join(root, "user-settings.json");
      const paths = [
        user,
        join(cwd, ".claude", "settings.json"),
        ...(canonical ? [join(cwd, ".claude", "settings.local.json")] : []),
        join(localRoot, ".claude", "settings.local.json"),
        main,
      ];
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await mkdir(join(localRoot, ".claude"), { recursive: true });
      for (const path of paths) await writeFile(path, "{}");
      const id = "example@example";
      await writeFile(
        join(cwd, ".claude", "settings.local.json"),
        JSON.stringify({ enabledPlugins: { [id]: false } }),
      );
      await writeFile(
        join(localRoot, ".claude", "settings.local.json"),
        JSON.stringify({ enabledPlugins: { [id]: true } }),
      );
      const observed = await readClaudeScopedSettings(
        capabilities,
        user,
        cwd,
        [main],
        localRoot,
      );
      expect(observed.map((entry) => entry.guard.targetPath)).toEqual(paths);
      expect(observed.map((entry) => entry.layer.scope)).toEqual([
        "user",
        "project",
        ...(canonical ? ["local"] : []),
        "local",
        "managed",
      ]);
      expect(observed.every((entry) => entry.guard.exists)).toBe(true);
      expect(
        observed
          .filter((entry) => entry.layer.scope === "local")
          .map((entry) => entry.layer.enabledPlugins),
      ).toEqual(
        canonical ? [{ [id]: false }, { [id]: true }] : [{ [id]: true }],
      );
    },
  );
});

describe("canonical local root projection from held ownership facts", () => {
  const owned = { rootUid: 0, gitEntryUid: 0, claudeEntryUid: 0 };
  it("accepts zero UID and an explicitly absent .claude entry", () => {
    expect(
      selectClaudeCanonicalLocalRoot(
        "/work/nested",
        "/work",
        "/home",
        0,
        owned,
      ),
    ).toBe("/work");
    expect(
      selectClaudeCanonicalLocalRoot("/work/nested", "/work", "/home", 0, {
        ...owned,
        claudeEntryUid: null,
      }),
    ).toBe("/work");
  });
  it.each([
    undefined,
    {},
    { ...owned, rootUid: 1 },
    { ...owned, gitEntryUid: 1 },
    { ...owned, claudeEntryUid: 1 },
    { rootUid: 0, gitEntryUid: 0 },
    { ...owned, rootUid: null },
  ])(
    "falls back rather than treating missing or mismatched metadata as ownership",
    (ownership) => {
      expect(
        selectClaudeCanonicalLocalRoot(
          "/work/nested",
          "/work",
          "/home",
          0,
          ownership,
        ),
      ).toBe("/work/nested");
    },
  );
  it.each([null, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps cwd for unavailable or malformed effective UID %s",
    (uid) => {
      expect(
        selectClaudeCanonicalLocalRoot(
          "/work/nested",
          "/work",
          "/home",
          uid,
          owned,
        ),
      ).toBe("/work/nested");
    },
  );
  it("does not canonicalize to home or when real-home resolution failed", () => {
    expect(
      selectClaudeCanonicalLocalRoot(
        "/work/nested",
        "/home",
        "/home",
        0,
        owned,
      ),
    ).toBe("/work/nested");
    expect(
      selectClaudeCanonicalLocalRoot("/work/nested", "/work", null, 0, owned),
    ).toBe("/work/nested");
  });
  it("needs no ownership observation when the candidate is absent or already cwd", () => {
    expect(selectClaudeCanonicalLocalRoot("/work", null, null, null)).toBe(
      "/work",
    );
    expect(selectClaudeCanonicalLocalRoot("/work", "/work", null, null)).toBe(
      "/work",
    );
  });
});

describe("preliminary managed-settings discovery", () => {
  it("binds an absent directory without inventing drop-in files", async () => {
    const { main, directory } = await fixture();
    expect(await discoverClaudeManagedSettings(capabilities, main)).toEqual({
      paths: [main],
      ignoredDirectories: [],
      selection: { directoryPath: directory, exists: false, entries: [] },
    });
  });

  it("keeps main first, sorted non-hidden JSON drop-ins next and all names guarded", async () => {
    const { main, directory } = await fixture();
    await mkdir(directory);
    for (const name of ["b.json", "a.json", ".hidden.json", "other.txt"])
      await writeFile(join(directory, name), "{}");
    const observed = await discoverClaudeManagedSettings(capabilities, main);
    expect(observed.paths).toEqual([
      main,
      join(directory, "a.json"),
      join(directory, "b.json"),
    ]);
    expect(observed.selection.entries).toEqual([
      ".hidden.json",
      "a.json",
      "b.json",
      "other.txt",
    ]);
    expect(Object.isFrozen(observed.selection.entries)).toBe(true);
  });

  it("binds ignored JSON directories without selecting them as settings", async () => {
    const { main, directory } = await fixture();
    await mkdir(directory);
    await mkdir(join(directory, "ignored.json"));
    const observed = await discoverClaudeManagedSettings(capabilities, main);
    expect(observed.paths).toEqual([main]);
    expect(observed.ignoredDirectories).toEqual([
      join(directory, "ignored.json"),
    ]);
    expect(
      claudeSettingsDirectoriesAgree(
        [{ directoryPath: observed.ignoredDirectories[0]!, exists: true }],
        [
          {
            directoryPath: observed.ignoredDirectories[0]!,
            exists: true,
            entries: ["irrelevant"],
            mode: 0o755,
          },
        ],
      ),
    ).toBe(true);
  });
  it("refuses a concrete unbindable JSON symlink drop-in", async () => {
    const { root, main, directory } = await fixture();
    await mkdir(directory);
    await writeFile(join(root, "target"), "{}");
    await symlink(join(root, "target"), join(directory, "entry.json"));
    await expect(
      discoverClaudeManagedSettings(capabilities, main),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });

  it("does not follow a substituted managed directory", async () => {
    const { root, main, directory } = await fixture();
    await mkdir(join(root, "replacement"));
    await symlink(join(root, "replacement"), directory);
    await expect(
      discoverClaudeManagedSettings(capabilities, main),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });

  it("refuses beyond the raw consulted-row bound", async () => {
    const { main, directory } = await fixture();
    await mkdir(directory);
    for (let index = 0; index < 10; index += 1)
      await writeFile(join(directory, `${index}.json`), "{}");
    await expect(
      discoverClaudeManagedSettings(capabilities, main),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });
});

describe("managed selection consumes the existing Core directory snapshot", () => {
  const selected = {
    directoryPath: "/policy/managed-settings.d",
    exists: true,
    entries: ["a.json", "b.json"],
  };
  const observed = { ...selected, mode: 0o755 };
  it("requires one exact same-name snapshot without using enumeration order", () => {
    expect(
      claudeSettingsDirectoriesAgree(
        [selected],
        [{ ...observed, entries: ["b.json", "a.json"] }],
      ),
    ).toBe(true);
    for (const entries of [
      ["a.json"],
      ["a.json", "b.json", "c.json"],
      ["a.json", "a.json"],
    ])
      expect(
        claudeSettingsDirectoriesAgree([selected], [{ ...observed, entries }]),
      ).toBe(false);
    expect(claudeSettingsDirectoriesAgree([selected], [])).toBe(false);
    expect(
      claudeSettingsDirectoriesAgree([selected], [observed, observed]),
    ).toBe(false);
    expect(
      claudeSettingsDirectoriesAgree(
        [selected],
        [{ ...observed, exists: false }],
      ),
    ).toBe(false);
  });
  it("also binds absence so a new policy directory cannot silently appear", () => {
    const absent = { ...selected, exists: false, entries: [] };
    expect(
      claudeSettingsDirectoriesAgree([absent], [{ ...absent, mode: null }]),
    ).toBe(true);
    expect(
      claudeSettingsDirectoriesAgree(
        [absent],
        [{ ...absent, exists: true, mode: 0o755 }],
      ),
    ).toBe(false);
  });
});

describe("pinned plaintext credential-file path projection, not store absence", () => {
  it("does not consult the unrelated cowork settings selector", () => {
    let invoked = false;
    const environment = Object.defineProperty(
      {},
      "CLAUDE_CODE_USE_COWORK_PLUGINS",
      {
        get() {
          invoked = true;
          return "must-not-evaluate";
        },
      },
    );
    expect(
      claudePlaintextCredentialPath("/home/user", "/work/project", environment),
    ).toBe("/home/user/.claude/.credentials.json");
    expect(invoked).toBe(false);
  });
  it.each([
    [undefined, undefined, "/home/user/.claude/.credentials.json"],
    [undefined, "", "/work/project/.credentials.json"],
    [undefined, "/custom/config", "/custom/config/.credentials.json"],
    ["", "/custom/config", "/home/user/.claude/.credentials.json"],
    [
      "relative-store",
      "/custom/config",
      "/work/project/relative-store/.credentials.json",
    ],
    ["~/literal", undefined, "/work/project/~/literal/.credentials.json"],
    ["/custom/cafe\u0301", undefined, "/custom/caf\u00e9/.credentials.json"],
  ])("projects secure/config controls %s/%s", (secure, config, expected) => {
    expect(
      claudePlaintextCredentialPath("/home/user", "/work/project", {
        ...(secure === undefined
          ? {}
          : { CLAUDE_SECURESTORAGE_CONFIG_DIR: secure }),
        ...(config === undefined ? {} : { CLAUDE_CONFIG_DIR: config }),
      }),
    ).toBe(expected);
  });
  it("rejects the captured accessor without evaluating it", () => {
    let invoked = false;
    const environment = Object.defineProperty(
      {},
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      {
        get() {
          invoked = true;
          return "/must-not-evaluate";
        },
      },
    );
    expect(() =>
      claudePlaintextCredentialPath(
        "/home/user",
        "/work/project",
        captureClaudeEnvironment(environment),
      ),
    ).toThrow();
    expect(invoked).toBe(false);
  });
});

import { capabilities } from "./__tests__/discovery-fixture.js";
