import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectPathsInChildForTesting } from "./path-inspection.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("deadline-owned path inspection process", () => {
  it("resolves workspace and repository paths through a joined child", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentscope-path-child-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const commonDirectory = join(root, ".git");
    await mkdir(workspace);
    await mkdir(commonDirectory);
    const canonicalRoot = await realpath(root);
    await expect(
      inspectPathsInChildForTesting(
        { kind: "workspace", paths: [join(root, "missing"), workspace] },
        1_000,
        {},
      ),
    ).resolves.toMatchObject({ kind: "workspace", index: 1 });
    await expect(
      inspectPathsInChildForTesting(
        { kind: "canonicalize", worktree: root, commonDirectory },
        1_000,
        {},
      ),
    ).resolves.toMatchObject({
      kind: "canonicalize",
      worktree: canonicalRoot,
      repositoryRoot: canonicalRoot,
    });
  });

  it("kills and joins timeout and abort paths before rejecting", async () => {
    for (const mode of ["timeout", "abort"] as const) {
      let processId: number | undefined;
      const controller = new AbortController();
      const operation = inspectPathsInChildForTesting(
        { kind: "workspace", paths: [] },
        mode === "timeout" ? 20 : 1_000,
        {
          program: "setInterval(() => undefined, 1000);",
          onSpawn: (value) => {
            processId = value;
          },
        },
        controller.signal,
      );
      if (mode === "abort") controller.abort();
      await expect(operation).rejects.toThrow(
        "core.path-inspection.unavailable",
      );
      expect(processId).toBeTypeOf("number");
      expect(() => process.kill(processId!, 0)).toThrow();
    }
  });

  it("contains crash, malformed, oversized, and spawn failures", async () => {
    for (const program of [
      "process.exit(2);",
      'process.stdout.write("not-json");',
      `process.stdout.write("x".repeat(40000));`,
      'process.stdout.write(JSON.stringify({kind:"workspace",index:99,path:"/"}));',
    ])
      await expect(
        inspectPathsInChildForTesting({ kind: "workspace", paths: [] }, 1_000, {
          program,
        }),
      ).rejects.toThrow("core.path-inspection.unavailable");
    await expect(
      inspectPathsInChildForTesting({ kind: "workspace", paths: [] }, 1_000, {
        executable: "/definitely/not/node",
      }),
    ).rejects.toThrow("core.path-inspection.unavailable");
    let abortedReads = 0;
    const changingSignal = new Proxy(new AbortController().signal, {
      get(target, property) {
        if (property === "aborted") {
          abortedReads += 1;
          return abortedReads > 1;
        }
        if (property === "addEventListener")
          return target.addEventListener.bind(target);
        if (property === "removeEventListener")
          return target.removeEventListener.bind(target);
        return Reflect.get(target, property, target) as unknown;
      },
    });
    await expect(
      inspectPathsInChildForTesting(
        { kind: "workspace", paths: [] },
        1_000,
        {},
        changingSignal,
      ),
    ).rejects.toThrow("core.path-inspection.unavailable");
    for (const program of [
      'process.stdout.write(JSON.stringify({kind:"canonicalize",worktree:1,repositoryRoot:"/"}));',
      'process.stdout.write(JSON.stringify({kind:"canonicalize",worktree:"/",repositoryRoot:1}));',
    ])
      await expect(
        inspectPathsInChildForTesting(
          { kind: "canonicalize", worktree: "/", commonDirectory: "/.git" },
          1_000,
          { program },
        ),
      ).rejects.toThrow("core.path-inspection.unavailable");
  });
});

describe("path inspection hostile admission", () => {
  it("rejects invalid admission and hostile optional signals", async () => {
    await expect(
      inspectPathsInChildForTesting({ kind: "workspace", paths: [] }, 0, {}),
    ).rejects.toThrow("core.path-inspection.unavailable");
    await expect(
      inspectPathsInChildForTesting(
        { kind: "workspace", paths: [] },
        Number.NaN,
        {},
      ),
    ).rejects.toThrow("core.path-inspection.unavailable");
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectPathsInChildForTesting(
        { kind: "workspace", paths: [] },
        1_000,
        {},
        controller.signal,
      ),
    ).rejects.toThrow("core.path-inspection.unavailable");
    await expect(
      inspectPathsInChildForTesting(
        { kind: "workspace", paths: ["x".repeat(70_000)] },
        1_000,
        {},
      ),
    ).rejects.toThrow("core.path-inspection.unavailable");
    const hostileSignal = new Proxy(new AbortController().signal, {
      get(target, property) {
        if (property === "aborted") throw new Error("hostile signal");
        if (property === "addEventListener")
          return target.addEventListener.bind(target);
        if (property === "removeEventListener")
          return target.removeEventListener.bind(target);
        return Reflect.get(target, property, target) as unknown;
      },
    });
    await expect(
      inspectPathsInChildForTesting(
        { kind: "workspace", paths: [] },
        1_000,
        {},
        hostileSignal,
      ),
    ).rejects.toThrow("core.path-inspection.unavailable");
    const removeHostileSignal = new Proxy(new AbortController().signal, {
      get(target, property) {
        if (property === "removeEventListener")
          return () => {
            throw new Error("hostile removal");
          };
        if (property === "addEventListener")
          return target.addEventListener.bind(target);
        return Reflect.get(target, property, target) as unknown;
      },
    });
    await expect(
      inspectPathsInChildForTesting(
        { kind: "workspace", paths: [] },
        1_000,
        {},
        removeHostileSignal,
      ),
    ).rejects.toThrow("core.path-inspection.unavailable");
  });
});
