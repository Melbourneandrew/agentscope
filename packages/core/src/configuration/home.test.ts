import { lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentscopeHomeError,
  createAgentscopeHomeResolver,
  ensureAgentscopeHomeLayout,
} from "./home.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryRoot = async (): Promise<string> => {
  const { mkdtemp } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "agentscope-home-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

describe("Agentscope home resolution", () => {
  it("resolves one memoized POSIX default layout", () => {
    let calls = 0;
    const resolver = createAgentscopeHomeResolver({
      environment: {},
      homedir: () => {
        calls += 1;
        return "/Users/example";
      },
      platform: "darwin",
    });
    const first = resolver();
    expect(resolver()).toBe(first);
    expect(calls).toBe(1);
    expect(first).toMatchObject({
      root: "/Users/example/.agentscope",
      configFile: "/Users/example/.agentscope/config.json",
      destinationDirectory: "/Users/example/.agentscope/destinations",
      platform: "darwin",
    });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("uses Windows joining semantics and the exact override", () => {
    const windows = createAgentscopeHomeResolver({
      environment: {},
      homedir: () => "C:\\Users\\example",
      platform: "win32",
    })();
    expect(windows.root).toBe("C:\\Users\\example\\.agentscope");
    expect(windows.healthDirectory).toBe(
      "C:\\Users\\example\\.agentscope\\health",
    );
    const overridden = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: "D:\\portable\\agentscope" },
      environmentOverrideAuthority: "portable",
      homedir: () => {
        throw new Error("override must replace homedir");
      },
      platform: "win32",
    })();
    expect(overridden.root).toBe("D:\\portable\\agentscope");
  });

  it("rejects ambiguous or dangerously broad roots", () => {
    for (const value of ["", "   ", "relative", "/", "/tmp/\0bad"]) {
      expect(() =>
        createAgentscopeHomeResolver({
          environment: { AGENTSCOPE_HOME: value },
          environmentOverrideAuthority: "test",
          homedir: () => "/unused",
          platform: "linux",
        }),
      ).toThrowError(AgentscopeHomeError);
    }
    expect(() =>
      createAgentscopeHomeResolver({
        environment: {},
        homedir: () => "relative",
        platform: "linux",
      }),
    ).toThrowError(AgentscopeHomeError);
    expect(() =>
      createAgentscopeHomeResolver({
        environment: { AGENTSCOPE_HOME: "C:\\" },
        environmentOverrideAuthority: "test",
        homedir: () => "C:\\Users\\unused",
        platform: "win32",
      }),
    ).toThrowError(AgentscopeHomeError);
    expect(() =>
      createAgentscopeHomeResolver({
        environment: {},
        homedir: () => {
          throw new Error("CANARY_SECRET");
        },
        platform: "linux",
      }),
    ).toThrowError(AgentscopeHomeError);
    expect(() =>
      createAgentscopeHomeResolver({
        environment: { AGENTSCOPE_HOME: `/tmp/${"a".repeat(4_100)}` },
        environmentOverrideAuthority: "test",
        platform: "linux",
      }),
    ).toThrowError(AgentscopeHomeError);
  });

  it("uses the process defaults only through the one resolver", () => {
    const home = createAgentscopeHomeResolver()();
    expect(home.root.endsWith(".agentscope")).toBe(true);
    expect(home.platform).toBe(process.platform);
  });

  it("ignores ambient overrides without an explicit invocation authority", () => {
    const home = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: "/project/controlled" },
      homedir: () => "/Users/trusted",
      platform: "darwin",
    })();
    expect(home.root).toBe("/Users/trusted/.agentscope");
  });
});

describe("Agentscope home layout", () => {
  it("creates and tightens every owned directory on POSIX", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "owned");
    await mkdir(root, { mode: 0o777 });
    const home = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: root },
      environmentOverrideAuthority: "test",
      platform: "linux",
    })();
    await expect(ensureAgentscopeHomeLayout(home)).resolves.toBe(home);
    for (const directory of [
      home.root,
      home.mutationDirectory,
      home.destinationDirectory,
      home.diagnosticDirectory,
      home.healthDirectory,
      home.checkpointDirectory,
    ]) {
      const state = await lstat(directory);
      expect(state.isDirectory()).toBe(true);
      expect(state.mode & 0o777).toBe(0o700);
    }
  });

  it("does not chmod directories under Windows semantics", async () => {
    const parent = await temporaryRoot();
    const nativeRoot = join(parent, "windows-owned");
    const home = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: nativeRoot },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    })();
    const windowsHome = Object.freeze({ ...home, platform: "win32" as const });
    await expect(ensureAgentscopeHomeLayout(windowsHome)).rejects.toThrowError(
      AgentscopeHomeError,
    );
  });

  it("rejects forged, file, and symlinked roots", async () => {
    const parent = await temporaryRoot();
    const legitimate = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: join(parent, "legitimate") },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    })();
    await expect(
      ensureAgentscopeHomeLayout({ ...legitimate }),
    ).rejects.toThrowError(AgentscopeHomeError);

    const fileRoot = join(parent, "file-root");
    await writeFile(fileRoot, "not a directory");
    const fileHome = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: fileRoot },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    })();
    await expect(ensureAgentscopeHomeLayout(fileHome)).rejects.toThrowError(
      AgentscopeHomeError,
    );

    const target = join(parent, "target");
    const link = join(parent, "link");
    await mkdir(target);
    await symlink(target, link, "dir");
    expect(await readlink(link)).toBe(target);
    const linkedHome = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: link },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    })();
    await expect(ensureAgentscopeHomeLayout(linkedHome)).rejects.toThrowError(
      AgentscopeHomeError,
    );

    const nestedRoot = join(parent, "nested-root");
    const nestedTarget = join(parent, "nested-target");
    await mkdir(nestedRoot);
    await mkdir(nestedTarget);
    await symlink(nestedTarget, join(nestedRoot, "destinations"), "dir");
    const nestedHome = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: nestedRoot },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    })();
    await expect(ensureAgentscopeHomeLayout(nestedHome)).rejects.toThrowError(
      AgentscopeHomeError,
    );
    expect((await lstat(nestedTarget)).isDirectory()).toBe(true);
  });
});
