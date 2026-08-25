import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  IMAGE_PREPARATION_LIMITS,
  classifyProcessGroupState,
  preparePinnedDockerImages,
  publishPreparedImageEvidence,
} from "../image-preparation.mjs";

const fixture = resolve(
  import.meta.dirname,
  "../fixtures/image-preparation-process.mjs",
);
const image = `example.invalid/fixture@sha256:${"b".repeat(64)}`;
const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-image-preparation-"));
  roots.push(root);
  return root;
};
const options = (root: string, mode: string) => ({
  dockerExecutable: process.execPath,
  dockerArgumentsPrefix: [fixture],
  environment: {
    ...process.env,
    AGENTSCOPE_IMAGE_FIXTURE_MODE: mode,
    AGENTSCOPE_IMAGE_FIXTURE_ROOT: root,
    DOCKER_AUTH_CONFIG: "CANARY_AUTHORITY",
    DOCKER_CONFIG: "/forbidden/developer/docker-config",
  },
  maximumPreparationMilliseconds: 2_000,
  teardownMilliseconds: 500,
});
const waitForFile = async (path: string) => {
  const deadline = performance.now() + 1_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline)
      throw new Error("integration.images.fixture");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
};
const proveDescendantAbsent = (root: string) => {
  const pid = Number(readFileSync(resolve(root, "ready"), "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow(
    expect.objectContaining({ code: "ESRCH" }),
  );
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("pinned Docker image preparation", () => {
  it("uses a private credential-free Docker config and returns exact evidence", async () => {
    const root = createRoot();
    await expect(
      preparePinnedDockerImages([image], options(root, "success")),
    ).resolves.toEqual([
      { image, localImageDigest: `sha256-${"a".repeat(64)}` },
    ]);
    const record = JSON.parse(
      readFileSync(resolve(root, "record.json"), "utf8"),
    ) as {
      dockerAuthConfigPresent: boolean;
      dockerConfigPath: string;
      dockerConfig: unknown;
    };
    expect(record).toMatchObject({
      commandArguments: ["image", "inspect", "--format", "{{.Id}}", image],
      dockerAuthConfigPresent: false,
      dockerConfig: { auths: {} },
    });
    expect(existsSync(record.dockerConfigPath)).toBe(false);
  });

  it("kills and joins a signal-resistant process group before retry", async () => {
    const root = createRoot();
    await expect(
      preparePinnedDockerImages([image], {
        ...options(root, "hang-once"),
        closeBarrier: () => Promise.resolve(),
        maximumPreparationMilliseconds: 1_500,
        teardownMilliseconds: 500,
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "integration.images.timeout",
    });
    proveDescendantAbsent(root);
    await expect(
      preparePinnedDockerImages([image], options(root, "hang-once")),
    ).resolves.toHaveLength(1);
  });

  it("joins the process group when the owning preparation is interrupted", async () => {
    const root = createRoot();
    const controller = new AbortController();
    const preparation = preparePinnedDockerImages([image], {
      ...options(root, "hang"),
      signal: controller.signal,
    });
    const settlement = preparation.then(
      () => ({ state: "resolved" as const, error: undefined }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    );
    await waitForFile(resolve(root, "ready"));
    controller.abort();
    await expect(settlement).resolves.toMatchObject({
      state: "rejected",
      error: { message: "integration.images.interrupted" },
    });
    proveDescendantAbsent(root);
  });

  it("bounds a missing close observation with final group-absence proof", async () => {
    const root = createRoot();
    await expect(
      preparePinnedDockerImages([image], {
        ...options(root, "hang"),
        closeBarrier: () => new Promise<void>(() => {}),
        maximumPreparationMilliseconds: 800,
        teardownMilliseconds: 400,
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "integration.images.timeout",
    });
    proveDescendantAbsent(root);
    const record = JSON.parse(
      readFileSync(resolve(root, "record.json"), "utf8"),
    ) as { dockerConfigPath: string };
    expect(existsSync(record.dockerConfigPath)).toBe(false);
  });

  it("does not let a throwing observation barrier bypass containment", async () => {
    const root = createRoot();
    await expect(
      preparePinnedDockerImages([image], {
        ...options(root, "hang"),
        closeBarrier: () => {
          throw new Error("CANARY_OBSERVER");
        },
        maximumPreparationMilliseconds: 800,
        teardownMilliseconds: 400,
      }),
    ).rejects.toThrow("integration.images.timeout");
    proveDescendantAbsent(root);
  });

  it("fails closed on oversized subprocess diagnostics", async () => {
    const root = createRoot();
    await expect(
      preparePinnedDockerImages([image], options(root, "oversized")),
    ).rejects.toThrow("integration.images.output");
  });
});

describe("image preparation failure boundaries", () => {
  it("classifies only exact-PGID zombie remnants as quiescent", () => {
    expect(classifyProcessGroupState(" 11 7 Z\n 12 7 Z+\n", 7)).toBe(
      "zombie-only",
    );
    expect(classifyProcessGroupState(" 11 7 Z\n 12 7 R+\n", 7)).toBe("live");
    expect(classifyProcessGroupState(" 11 8 R\n", 7)).toBe("absent");
    expect(classifyProcessGroupState("CANARY_PATH\n", 7)).toBe("unavailable");
  });

  it("fails before spawn where an owned process group is unavailable", async () => {
    const root = createRoot();
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (descriptor === undefined) throw new Error("integration.images.fixture");
    try {
      Object.defineProperty(process, "platform", {
        ...descriptor,
        value: "win32",
      });
      await expect(
        preparePinnedDockerImages([image], {
          ...options(root, "success"),
          dockerExecutable: "/forbidden/docker",
        }),
      ).rejects.toThrow("integration.images.platform");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("removes the private Docker config after a setup prefix fails", async () => {
    const root = createRoot();
    const before = new Set(
      readdirSync(tmpdir()).filter((entry) =>
        entry.startsWith("agentscope-docker-config-"),
      ),
    );
    const environment = new Proxy(process.env, {
      ownKeys: () => {
        throw new Error("CANARY_PATH");
      },
    });
    await expect(
      preparePinnedDockerImages([image], {
        ...options(root, "success"),
        environment,
      }),
    ).rejects.toThrow("integration.images.setup");
    expect(
      new Set(
        readdirSync(tmpdir()).filter((entry) =>
          entry.startsWith("agentscope-docker-config-"),
        ),
      ),
    ).toEqual(before);
  });

  it("removes a failed publication stage and preserves the target", () => {
    const root = createRoot();
    const target = resolve(root, "current-images.json");
    mkdirSync(target);
    expect(() => {
      publishPreparedImageEvidence(target, { imageEvidenceVersion: 1 });
    }).toThrow("integration.images.publication");
    expect(readdirSync(root)).toEqual(["current-images.json"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("publishes the documented fixed preparation ceilings", () => {
    expect(IMAGE_PREPARATION_LIMITS).toEqual({
      maximumPreparationMilliseconds: 300_000,
      maximumTeardownMilliseconds: 5_000,
      maximumCommandOutputBytes: 65_536,
    });
  });
});
