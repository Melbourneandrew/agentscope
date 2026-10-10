import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyBuildxStderrForTesting,
  authenticateDockerSocketAliasForTesting,
  createBoundedBuildContext,
  IMAGE_PREPARATION_LIMITS,
  runOwnedImageCommandForTesting,
} from "../image-preparation.mjs";
import {
  buildArgumentsFor,
  selectBuildOutput,
} from "../image-preparation/build-policy.mjs";

import {
  maximumBuildArtifactBytes,
  readBuildArtifactTar,
} from "../image-preparation/build-artifact.mjs";

const failure = "integration.images.build.artifact";
const roots: string[] = [];
const root = () => {
  const directory = mkdtempSync(
    resolve(tmpdir(), "agentscope-build-artifact-"),
  );
  roots.push(directory);
  return directory;
};
const executableFixture = () => {
  const source = realpathSync(process.execPath).replaceAll("'", "'\\''");
  const target = resolve(root(), "node");
  const script = `#!/bin/sh\nexec '${source}' "$@"\n`;
  writeFileSync(target, script, { flag: "wx", mode: 0o500 });
  chmodSync(target, 0o500);
  expect(readFileSync(target, "utf8")).toBe(script);
  return target;
};
afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true });
});
const buildContext = () => {
  const directory = root();
  writeFileSync(resolve(directory, "Dockerfile"), "FROM scratch\n");
  mkdirSync(resolve(directory, "nested"));
  writeFileSync(resolve(directory, "nested/input.txt"), "fixture\n");
  return directory;
};
const checksum = (archive: Buffer) => {
  archive.fill(32, 148, 156);
  const sum = archive.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  archive.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
};
const tar = (payload = Buffer.from('{"research":true}')) => {
  const archive = Buffer.alloc(
    512 + Math.ceil(payload.length / 512) * 512 + 1024,
  );
  archive.write("material.json");
  const fields: readonly (readonly [number, number, number])[] = [
    [100, 8, 0o644],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, payload.length],
    [136, 12, 0],
    [329, 8, 0],
    [337, 8, 0],
  ];
  for (const [offset, length, value] of fields)
    archive.write(
      `${value.toString(8).padStart(length - 1, "0")}\0`,
      offset,
      "ascii",
    );
  archive[156] = 48;
  archive.write("ustar\0", 257, "ascii");
  archive.write("00", 263, "ascii");
  payload.copy(archive, 512);
  checksum(archive);
  return archive;
};

describe("bounded build research tar", () => {
  it("returns owned exact bytes without JSON parsing or extraction", () => {
    const payload = Buffer.from([0, 255, 128, 10]);
    const archive = tar(payload);
    const result = readBuildArtifactTar(archive);
    expect(result).toEqual(payload);
    archive.fill(1);
    expect(result).toEqual(payload);
  });
  it.each(["../material.json", "/material.json", "other.json"])(
    "rejects name %s",
    (name) => {
      const archive = tar();
      archive.fill(0, 0, 100);
      archive.write(name);
      checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it.each([49, 50, 51, 52, 53, 54, 55, 76, 120])(
    "rejects nonregular type %i",
    (type) => {
      const archive = tar();
      archive[156] = type;
      checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it.each([100, 108, 116, 124, 136, 148, 157, 257, 263, 265, 329, 337, 345])(
    "rejects malformed authority/header field %i",
    (offset) => {
      const archive = tar();
      archive[offset] = 255;
      if (offset !== 148) checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it("rejects truncation, nonzero padding, extra members and excess bytes", () => {
    const archive = tar();
    for (const invalid of [
      archive.subarray(0, 1024),
      archive.subarray(0, archive.length - 1),
      Buffer.concat([archive, Buffer.from([0])]),
      Buffer.alloc(maximumBuildArtifactBytes + 10241),
    ])
      expect(() => readBuildArtifactTar(invalid)).toThrow(failure);
    archive[900] = 1;
    expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    const duplicate = Buffer.concat([tar().subarray(0, 1024), tar()]);
    expect(() => readBuildArtifactTar(duplicate)).toThrow(failure);
  });
  it("accepts the inclusive payload bound and rejects empty/excess payload", () => {
    expect(
      readBuildArtifactTar(tar(Buffer.alloc(maximumBuildArtifactBytes))).length,
    ).toBe(maximumBuildArtifactBytes);
    for (const size of [0, maximumBuildArtifactBytes + 1])
      expect(() => readBuildArtifactTar(tar(Buffer.alloc(size)))).toThrow(
        failure,
      );
  });
  it.each([108, 116, 329, 337])(
    "rejects nonzero ownership/device field %i",
    (offset) => {
      const archive = tar();
      archive.write("0000001\0", offset, "ascii");
      checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it.each([100, 108, 116, 124, 136, 148, 263, 264, 329, 337])(
    "rejects high-bit numeric/version substitution %i",
    (offset) => {
      const archive = tar();
      archive[offset] = archive[offset]! | 0x80;
      if (offset !== 148) checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it("rejects post-NUL name data and nonzero terminal padding", () => {
    for (const offset of [30, 1535]) {
      const archive = tar();
      archive[offset] = 65;
      if (offset < 512) checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    }
  });
  it("rejects proxies without consulting their properties", () => {
    let effects = 0;
    const input = new Proxy(tar(), {
      get() {
        effects += 1;
        throw new Error("trap");
      },
    });
    expect(() => readBuildArtifactTar(input)).toThrow(failure);
    expect(effects).toBe(0);
  });
});

describe("canonical Docker socket authority", () => {
  it("binds a fixed socket alias to its one canonical physical endpoint", async () => {
    const directory = root();
    const physicalDirectory = resolve(directory, "run");
    const aliasDirectory = resolve(directory, "var-run");
    mkdirSync(physicalDirectory);
    symlinkSync(physicalDirectory, aliasDirectory);
    const physicalSocket = resolve(physicalDirectory, "docker.sock");
    const canonicalPhysicalSocket = resolve(
      realpathSync(physicalDirectory),
      "docker.sock",
    );
    const policySocket = resolve(aliasDirectory, "docker.sock");
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(physicalSocket, () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    });
    try {
      expect(
        authenticateDockerSocketAliasForTesting(
          policySocket,
          canonicalPhysicalSocket,
        ),
      ).toMatchObject({ path: canonicalPhysicalSocket });
      expect(() =>
        authenticateDockerSocketAliasForTesting(policySocket, policySocket),
      ).toThrow("integration.images.socket");
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
      });
    }
  });
});

describe("bounded build-context acquisition", () => {
  it("rejects symlink and pre-read size authority violations", () => {
    const context = buildContext();
    const rootLink = resolve(root(), "context-link");
    symlinkSync(context, rootLink);
    expect(() => createBoundedBuildContext(rootLink)).toThrow(
      "integration.images.build",
    );
    symlinkSync(resolve(context, "nested"), resolve(context, "nested-link"));
    expect(() => createBoundedBuildContext(context)).toThrow(
      "integration.images.build",
    );
    rmSync(resolve(context, "nested-link"));
    writeFileSync(resolve(context, "oversized"), "");
    truncateSync(resolve(context, "oversized"), 64 * 1024 * 1024 + 1);
    expect(() => createBoundedBuildContext(context)).toThrow(
      "integration.images.build",
    );
  });
  it("rejects same-inode mutation during context acquisition", () => {
    const context = buildContext();
    expect(() =>
      createBoundedBuildContext(context, {
        afterEntryForTesting: (entryCount) => {
          if (entryCount === 1)
            writeFileSync(resolve(context, "Dockerfile"), "FROM invalid\n");
        },
      }),
    ).toThrow("integration.images.build");
  });
  it("applies a selected bounded context ceiling without widening the default", () => {
    const context = buildContext();
    const archive = createBoundedBuildContext(context);
    expect(
      createBoundedBuildContext(context, { maximumBytes: archive.length }),
    ).toEqual(archive);
    expect(() =>
      createBoundedBuildContext(context, { maximumBytes: archive.length - 1 }),
    ).toThrow("integration.images.build");
    expect(() =>
      createBoundedBuildContext(context, {
        maximumBytes:
          IMAGE_PREPARATION_LIMITS.maximumHarnessBuildContextBytes + 1,
      }),
    ).toThrow("integration.images.build");
  });
});
describe("content-free buildx failure classification", () => {
  it.each([
    ["builder already exists", "resource-conflict"],
    ["failed to solve build graph", "build-failed"],
    ["connection refused during bootstrap", "bootstrap-failed"],
    ["operation not permitted", "permission-denied"],
    ["provider detail that has no admitted class", "unknown"],
    ["x".repeat(16_385), "unknown"],
    [{ malformed: true }, "unknown"],
  ])(
    "classifies bounded input without retaining content %#",
    (input, expected) => {
      expect(classifyBuildxStderrForTesting(input)).toBe(expected);
    },
  );
});
describe("same-kernel binary output", () => {
  const options = () => ({
    deadline: performance.now() + 4_000,
    teardownMilliseconds: 500,
  });
  it("preserves split invalid UTF8 bytes while default text stays text", async () => {
    const args = [
      "-e",
      "process.stdout.write(Buffer.from([255,192]));setTimeout(()=>process.stdout.write(Buffer.from([128,0])),5)",
    ];
    const node = executableFixture();
    const bytes = await runOwnedImageCommandForTesting(node, args, {
      ...options(),
      output: "binary",
    });
    expect(bytes).toEqual(Buffer.from([255, 192, 128, 0]));
    expect(
      await runOwnedImageCommandForTesting(
        node,
        ["-e", "process.stdout.write('text')"],
        options(),
      ),
    ).toBe("text");
  });
  it.each([null, "", "buffer", {}, new String("binary")])(
    "rejects unclosed serialization before executable inspection %#",
    async (output) => {
      await expect(
        runOwnedImageCommandForTesting("/missing-executable", [], {
          ...options(),
          output: output as "binary",
        }),
      ).rejects.toThrow("integration.images.build.input");
    },
  );
  it("preserves the combined output cap in binary mode", async () => {
    await expect(
      runOwnedImageCommandForTesting(
        executableFixture(),
        [
          "-e",
          "process.stderr.write(Buffer.alloc(16*1024*1024));process.stdout.write(Buffer.from([1]))",
        ],
        { ...options(), output: "binary" },
      ),
    ).rejects.toThrow("integration.images.output");
  });
  it("rejects cancellation at the terminal close barrier", async () => {
    const controller = new AbortController();
    await expect(
      runOwnedImageCommandForTesting(
        executableFixture(),
        ["-e", "process.stdout.write(Buffer.from([255]))"],
        {
          ...options(),
          output: "binary",
          signal: controller.signal,
          closeBarrierForTesting: () => {
            controller.abort();
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("integration.images.interrupted");
  });
  it("rejects an owned writable executable before payload execution", async () => {
    const node = executableFixture();
    const marker = resolve(node, "..", "payload");
    chmodSync(node, 0o775);
    await expect(
      runOwnedImageCommandForTesting(
        node,
        [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'must-not-run')`,
        ],
        options(),
      ),
    ).rejects.toThrow("integration.images.executable");
    expect(existsSync(marker)).toBe(false);
  });
  it("uses only the fixed tar stdout exporter without tag or image load", () => {
    expect(selectBuildOutput(undefined)).toBe("image");
    expect(() => selectBuildOutput("tar")).toThrow(
      "integration.images.build.input",
    );
    const args = buildArgumentsFor({
      buildArguments: {},
      labels: {},
      buildNetwork: "default",
      buildOutput: "evidence-tar",
      builder: "fixture",
      dockerfile: "Dockerfile",
      platform: { os: "linux", architecture: "amd64" },
    });
    expect(args).toEqual([
      "build",
      "--progress=plain",
      "--builder",
      "fixture",
      "--file",
      "Dockerfile",
      "--output",
      "type=tar,dest=-",
      "--network",
      "default",
      "--platform",
      "linux/amd64",
      "--pull=false",
      "-",
    ]);
  });
});
