import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error This private CI entry point deliberately has no package declaration.
import { uploadFailureEvidence } from "../upload-failure-evidence.mjs";

type ArtifactResponse = { digest?: string; id?: number; size?: number };
type UploadClient = {
  uploadArtifact: (
    name: string,
    files: string[],
    root: string,
    options: { compressionLevel: number; retentionDays: number },
  ) => Promise<ArtifactResponse>;
};
type UploadFailureEvidence = (options: {
  arguments_: string[];
  client: UploadClient;
  nowNanoseconds: () => bigint;
  probe: (arguments_: string[]) => Promise<void>;
  startTicks: () => string;
}) => Promise<{
  artifactDigest: string;
  artifactId: number;
  artifactSize: number;
  status: "uploaded";
}>;
const invokeUpload = uploadFailureEvidence as unknown as UploadFailureEvidence;
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const digest = (content: Buffer) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;
const fixture = (): {
  arguments_: string[];
  content: Buffer;
  descriptor: number;
  root: string;
} => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-upload-"));
  const path = resolve(root, "evidence.json");
  const content = Buffer.from('{"bundleVersion":1}\n');
  writeFileSync(path, content, { mode: 0o400 });
  const descriptor = openSync(path, constants.O_RDONLY);
  const deadline = process.hrtime.bigint() + 30_000_000_000n;
  const arguments_ = [
    "--fd",
    String(descriptor),
    "--size",
    String(content.length),
    "--digest",
    digest(content),
    "--name",
    "integration-0-of-1-1",
    "--deadline",
    deadline.toString(),
    "--python",
    "/usr/bin/python3",
  ];
  return { arguments_, content, descriptor, root };
};

describe("failure evidence uploader", () => {
  it("uploads the exact retained descriptor once with closed options", async () => {
    const owned = fixture();
    try {
      const uploadArtifact = vi.fn(
        (..._arguments: Parameters<UploadClient["uploadArtifact"]>) =>
          Promise.resolve({
            digest: "a".repeat(64),
            id: 17,
            size: 321,
          }),
      );
      const probe = vi.fn((_arguments: string[]) => Promise.resolve());
      const receipt = await invokeUpload({
        arguments_: owned.arguments_,
        client: {
          uploadArtifact: (...arguments_) => uploadArtifact(...arguments_),
        },
        nowNanoseconds: () => process.hrtime.bigint(),
        probe,
        startTicks: () => "123",
      });
      expect(uploadArtifact).toHaveBeenCalledTimes(1);
      expect(uploadArtifact).toHaveBeenCalledWith(
        "integration-0-of-1-1",
        [`/proc/self/fd/${owned.descriptor}`],
        "/proc/self/fd",
        { compressionLevel: 0, retentionDays: 7 },
      );
      expect(probe).toHaveBeenCalledTimes(2);
      expect(receipt).toEqual({
        artifactDigest: `sha256:${"a".repeat(64)}`,
        artifactId: 17,
        artifactSize: 321,
        status: "uploaded",
      });
      expect(readFileSync(owned.descriptor)).toEqual(owned.content);
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("rejects substituted inputs and malformed terminal responses", async () => {
    const owned = fixture();
    const client: UploadClient = {
      uploadArtifact: () =>
        Promise.resolve({
          digest: "a".repeat(64),
          id: 17,
          size: 321,
        }),
    };
    const invoke = (
      arguments_: string[],
      selectedClient: UploadClient = client,
    ) =>
      invokeUpload({
        arguments_,
        client: selectedClient,
        nowNanoseconds: () => process.hrtime.bigint(),
        probe: () => Promise.resolve(),
        startTicks: () => "123",
      });
    try {
      const replace = (index: number, value: string) =>
        owned.arguments_.map((entry, selected) =>
          selected === index ? value : entry,
        );
      for (const arguments_ of [
        owned.arguments_.slice(0, -2),
        replace(1, String(owned.descriptor + 1)),
        replace(3, "0"),
        replace(5, `sha256:${"0".repeat(64)}`),
        replace(7, "INVALID"),
        replace(9, "1"),
        [...owned.arguments_, "--extra", "value"],
      ])
        await expect(invoke(arguments_)).rejects.toThrow(
          "integration.controller.failure-evidence-upload",
        );
      await expect(
        invoke(owned.arguments_, {
          uploadArtifact: () => Promise.resolve({ id: 0, size: 0 }),
        }),
      ).rejects.toThrow("integration.controller.failure-evidence-upload");
    } finally {
      closeSync(owned.descriptor);
      rmSync(owned.root, { force: true, recursive: true });
    }
  });

  it("contains no artifact list, download, delete, or retry authority", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../upload-failure-evidence.mjs"),
      "utf8",
    );
    expect(source.match(/\.uploadArtifact\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(
      /\.downloadArtifact\(|\.deleteArtifact\(|\.listArtifacts\(|\.getArtifact\(|retry/gu,
    );
    expect(source).toContain("Object.freeze({ uploadArtifact:");
    expect(source).toContain("retentionDays: 7");
  });
});

describe("failure evidence upload provenance", () => {
  it("pins the artifact client provenance and its narrow retained-FD patch", () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(workspaceRoot, "tests/integration/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    const rootPackage = JSON.parse(
      readFileSync(resolve(workspaceRoot, "package.json"), "utf8"),
    ) as { pnpm: { patchedDependencies: Record<string, string> } };
    const lock = readFileSync(resolve(workspaceRoot, "pnpm-lock.yaml"), "utf8");
    const patch = readFileSync(
      resolve(workspaceRoot, "patches/@actions__artifact@6.2.1.patch"),
    );
    expect(packageJson.dependencies["@actions/artifact"]).toBe("6.2.1");
    expect(rootPackage.pnpm.patchedDependencies).toEqual({
      "@actions/artifact@6.2.1": "patches/@actions__artifact@6.2.1.patch",
    });
    expect(lock).toContain(
      "integrity: sha512-sJGH0mhEbEjBCw7o6SaLhUU66u27aFW8HTfkIb5Tk2/Wy0caUDc+oYQEgnuFN7a0HCpAbQyK0U6U7XUJDgDWrw==",
    );
    expect(createHash("sha256").update(patch).digest("hex")).toBe(
      "9638aca3637f07d89c766e49c1719eb2f58a20b1165da4962ea755e9032c392b",
    );
    expect(patch.toString("utf8")).toContain(
      "validateRetainedDescriptorPath(file.sourcePath, file.stats)",
    );
    const entry = fileURLToPath(import.meta.resolve("@actions/artifact"));
    expect(entry).toContain("patch_hash=");
    expect(statSync(entry).isFile()).toBe(true);
    const uploadRoot = resolve(entry, "../internal/upload");
    expect(
      Object.fromEntries(
        [
          "path-and-artifact-name-validation.js",
          "stream.js",
          "upload-artifact.js",
          "zip.js",
        ].map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(resolve(uploadRoot, name)))
            .digest("hex"),
        ]),
      ),
    ).toEqual({
      "path-and-artifact-name-validation.js":
        "6ce71a90c3abefd252265b4bad1dc38fe3980014d11fca8a240596615d99a6d4",
      "stream.js":
        "5eeaefb718a18cc6ac399c3433348d84e1c26af50d3c3defbb92cf05d988f96a",
      "upload-artifact.js":
        "f4936f8c7119371f65f08d7bce855458ea6c9476febfa56a0e289a454bb5427e",
      "zip.js":
        "4bd1967f092499689cd0e26d116a3ad1a138dc27ac2d87adb2493697a3ac2adc",
    });
  });

  it("keeps the sealing handoff descriptor-minimal and pathname-free", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/seal-failure-evidence.py"),
      "utf8",
    );
    expect(source).toContain("os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING");
    expect(source).toContain("fcntl.F_ADD_SEALS, REQUIRED_SEALS");
    expect(source).toContain("inheritable_inventory() != {1, 2, descriptor}");
    expect(source).toContain("os.execve(");
    expect(source).toContain('"--input-type=module"');
    expect(source).toContain(
      'UPLOADER_SHA256 = "f6eaa60a18c974b2a0c9c5ff6052614eadec335b8a3b688355e3663835888221"',
    );
    expect(source).not.toMatch(/mkstemp|NamedTemporaryFile|\/tmp\/|sudo|tee/gu);
    expect(source.indexOf("os.fsync(descriptor)")).toBeLessThan(
      source.indexOf("fcntl.F_ADD_SEALS, REQUIRED_SEALS"),
    );
    expect(source.indexOf("fcntl.F_ADD_SEALS, REQUIRED_SEALS")).toBeLessThan(
      source.indexOf("os.execve("),
    );
  });
});

describe("Linux sealed failure evidence upload", () => {
  it.skipIf(process.platform !== "linux")(
    "execs the uploader in place with an immutable sealed descriptor",
    () => {
      const owned = fixture();
      const fixtureUploader = resolve(owned.root, "fixture-uploader.mjs");
      writeFileSync(
        fixtureUploader,
        `import { closeSync, fstatSync, ftruncateSync, writeSync } from "node:fs";
const values = Object.fromEntries(Array.from({ length: process.argv.slice(1).length / 2 }, (_, index) => [process.argv[index * 2 + 1], process.argv[index * 2 + 2]]));
const fd = Number(values["--fd"]);
const status = fstatSync(fd);
let rejected = 0;
for (const mutation of [() => writeSync(fd, Buffer.from("x"), 0, 1, 0), () => ftruncateSync(fd, 0), () => ftruncateSync(fd, status.size + 1)]) {
  try { mutation(); } catch { rejected += 1; }
}
if (fd !== 3 || rejected !== 3 || (status.mode & 0o7777) !== 0o400 || status.nlink !== 0) process.exit(1);
closeSync(fd);
process.stdout.write(JSON.stringify({ pid: process.pid, status: "sealed" }) + "\\n");
`,
        { mode: 0o400 },
      );
      const result = spawnSync(
        "/usr/bin/python3",
        [
          resolve(workspaceRoot, "tests/integration/seal-failure-evidence.py"),
          "seal",
          process.execPath,
          fixtureUploader,
          "integration-0-of-1-1",
          (process.hrtime.bigint() + 30_000_000_000n).toString(),
          digest(owned.content),
        ],
        {
          encoding: "utf8",
          env: {
            ACTIONS_RESULTS_URL:
              "https://results-receiver.actions.githubusercontent.com/",
            ACTIONS_RUNTIME_TOKEN: "fixture-token",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_WORKSPACE: workspaceRoot,
          },
          input: owned.content,
          timeout: 10_000,
        },
      );
      try {
        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual(
          expect.objectContaining({ status: "sealed" }),
        );
      } finally {
        closeSync(owned.descriptor);
        rmSync(owned.root, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "streams only one exact retained self memfd and rejects aliases",
    () => {
      const entry = fileURLToPath(import.meta.resolve("@actions/artifact"));
      const uploadRoot = resolve(entry, "../internal/upload");
      const program = `
        import { closeSync, constants, lstatSync, openSync } from "node:fs";
        import { DefaultArtifactClient } from ${JSON.stringify(pathToFileURL(entry).href)};
        import { validateRetainedDescriptorPath } from ${JSON.stringify(
          pathToFileURL(
            resolve(uploadRoot, "path-and-artifact-name-validation.js"),
          ).href,
        )};
        import { createZipUploadStream } from ${JSON.stringify(
          pathToFileURL(resolve(uploadRoot, "zip.js")).href,
        )};
        const path = "/proc/self/fd/3";
        if (!validateRetainedDescriptorPath(path, lstatSync(path))) process.exit(1);
        const stream = await createZipUploadStream([{ sourcePath: path, destinationPath: "/evidence.json", stats: lstatSync(path) }], 0);
        let bytes = 0;
        for await (const chunk of stream) bytes += chunk.length;
        if (bytes < 1) process.exit(1);
        if (validateRetainedDescriptorPath("/ordinary/symlink", { isSymbolicLink: () => true }) !== false) process.exit(1);
        for (const rejected of ["/proc/1/fd/3", "/proc/self/fd/3/x", "/proc/self/fd/*", "/dev/fd/3", "../proc/self/fd/3"]) {
          let failed = false;
          try { validateRetainedDescriptorPath(rejected, {}); } catch { failed = true; }
          if (!failed) process.exit(1);
        }
        let multiple = false;
        try { await new DefaultArtifactClient().uploadArtifact("fixture", [path, "/ordinary"], "/", { retentionDays: 7 }); } catch { multiple = true; }
        if (!multiple) process.exit(1);
        closeSync(3);
        const reused = openSync("/dev/null", constants.O_RDONLY);
        if (reused !== 3) process.exit(1);
        let substituted = false;
        try { validateRetainedDescriptorPath(path, lstatSync(path)); } catch { substituted = true; }
        closeSync(reused);
        if (!substituted) process.exit(1);
      `;
      const python = `
import fcntl, os
content = b'{"bundleVersion":1}\\n'
fd = os.memfd_create('agentscope-sanitized-failure-evidence', os.MFD_ALLOW_SEALING)
if fd != 3: raise SystemExit(1)
os.write(fd, content)
os.fchmod(fd, 0o400)
fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
os.set_inheritable(fd, True)
os.execve(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, '--input-type=module', '--eval', ${JSON.stringify(program)}], {})
`;
      const result = spawnSync("/usr/bin/python3", ["-c", python], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result).toEqual(
        expect.objectContaining({ signal: null, status: 0, stderr: "" }),
      );
    },
  );
});
