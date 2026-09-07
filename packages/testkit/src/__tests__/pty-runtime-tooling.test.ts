import { execFileSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const verifierUrl = pathToFileURL(
  resolve(packageRoot, "scripts/verify-pty-runtime.mjs"),
).href;
const acquisitionUrl = pathToFileURL(
  resolve(packageRoot, "scripts/acquire-pty-toolchain.mjs"),
).href;
const buildUrl = pathToFileURL(
  resolve(packageRoot, "scripts/build-pty-runtime.mjs"),
).href;
const roots: string[] = [];
const temporaryRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-pty-runtime-"));
  roots.push(root);
  return root;
};
const evaluate = (source: string, arguments_: string[] = []) =>
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", source, ...arguments_],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const writeTarString = (
  header: Buffer,
  offset: number,
  bytes: number,
  value: string,
) => header.write(value, offset, bytes, "ascii");
const tar = (
  entries: Array<{
    contents: Buffer;
    mode: number;
    path: string;
    type?: string;
  }>,
) => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.path);
    writeTarString(
      header,
      100,
      8,
      `${entry.mode.toString(8).padStart(7, "0")}\0`,
    );
    writeTarString(header, 108, 8, "0000000\0");
    writeTarString(header, 116, 8, "0000000\0");
    writeTarString(
      header,
      124,
      12,
      `${entry.contents.length.toString(8).padStart(11, "0")}\0`,
    );
    writeTarString(header, 136, 12, "00000000000\0");
    header.fill(0x20, 148, 156);
    writeTarString(header, 156, 1, entry.type ?? "0");
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    writeTarString(
      header,
      148,
      8,
      `${checksum.toString(8).padStart(6, "0")}\0 `,
    );
    parts.push(header, entry.contents);
    const padding = (512 - (entry.contents.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
};

const syntheticPackage = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const payload = Buffer.from("toolchain-canary\n");
  const data = gzipSync(
    tar([{ contents: payload, mode: 0o755, path: "usr/bin/canary" }]),
  );
  const packageInfo = Buffer.from(
    `pkgname = canary\npkgver = 1-r0\narch = x86_64\ndatahash = ${sha256(data)}\n`,
  );
  const control = gzipSync(
    tar([{ contents: packageInfo, mode: 0o644, path: ".PKGINFO" }]),
  );
  const signature = signBytes("RSA-SHA1", control, privateKey);
  const signatureArchive = gzipSync(
    tar([
      {
        contents: signature,
        mode: 0o644,
        path: ".SIGN.RSA.alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub",
      },
    ]),
  );
  const bytes = Buffer.concat([signatureArchive, control, data]);
  const inventoryEntries = [
    {
      contents: signature,
      mode: 0o644,
      path: ".SIGN.RSA.alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub",
    },
    { contents: packageInfo, mode: 0o644, path: ".PKGINFO" },
    { contents: payload, mode: 0o755, path: "usr/bin/canary" },
  ];
  const inventory = sha256(
    `${inventoryEntries
      .map(
        ({ contents, mode, path }) =>
          `${path}\0${"0"}\0${mode.toString(8).padStart(4, "0")}\0${contents.length}\0\0${sha256(contents)}`,
      )
      .sort()
      .join("\n")}\n`,
  );
  const record = {
    bytes: bytes.length,
    filename: "canary-1-r0.apk",
    inventory,
    memberCount: 3,
    name: "canary",
    sha256: sha256(bytes),
    signedIndexChecksum: `Q1${createHash("sha1").update(control).digest("base64")}`,
    url: "https://invalid.example/canary-1-r0.apk",
    version: "1-r0",
  };
  return {
    bytes,
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    record,
  };
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("PTY runtime artifact tooling", () => {
  it("verifies the exact musl artifact without loading it", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve(packageRoot, "scripts/verify-pty-runtime.mjs")],
        { stdio: "pipe", timeout: 10_000 },
      ),
    ).not.toThrow();
  });

  it("rejects substituted and symlinked artifact bytes", () => {
    const root = temporaryRoot();
    mkdirSync(resolve(root, "pty-runtime/node127-linux-x64-musl"), {
      recursive: true,
    });
    writeFileSync(
      resolve(root, "pty-runtime-artifacts.json"),
      readFileSync(resolve(packageRoot, "pty-runtime-artifacts.json")),
    );
    writeFileSync(
      resolve(root, "pty-runtime-policy.json"),
      readFileSync(resolve(packageRoot, "pty-runtime-policy.json")),
    );
    writeFileSync(
      resolve(root, "pty-runtime/node127-linux-x64-musl/pty.node"),
      "substituted",
    );
    const verify = `const {verifyPtyRuntime}=await import(${JSON.stringify(verifierUrl)}); verifyPtyRuntime({root:process.argv[1],sourceRoot:process.argv[2]});`;
    const sourceRoot = resolve(packageRoot, "../..");
    expect(() => evaluate(verify, [root, sourceRoot])).toThrow(
      /artifact bytes do not match authority/u,
    );
    rmSync(resolve(root, "pty-runtime/node127-linux-x64-musl/pty.node"));
    symlinkSync(
      resolve(packageRoot, "pty-runtime/node127-linux-x64-musl/pty.node"),
      resolve(root, "pty-runtime/node127-linux-x64-musl/pty.node"),
    );
    expect(() => evaluate(verify, [root, sourceRoot])).toThrow(
      /too many levels of symbolic links|symbolic link|ELOOP/iu,
    );
  });

  it("rejects executable-mode and FIFO artifact substitutions without blocking", () => {
    const root = temporaryRoot();
    mkdirSync(resolve(root, "pty-runtime/node127-linux-x64-musl"), {
      recursive: true,
    });
    for (const file of [
      "pty-runtime-artifacts.json",
      "pty-runtime-policy.json",
    ])
      copyFileSync(resolve(packageRoot, file), resolve(root, file));
    const artifact = resolve(
      root,
      "pty-runtime/node127-linux-x64-musl/pty.node",
    );
    copyFileSync(
      resolve(packageRoot, "pty-runtime/node127-linux-x64-musl/pty.node"),
      artifact,
    );
    chmodSync(artifact, 0o755);
    const verify = `const {verifyPtyRuntime}=await import(${JSON.stringify(verifierUrl)}); verifyPtyRuntime({root:process.argv[1],sourceRoot:process.argv[2]});`;
    const sourceRoot = resolve(packageRoot, "../..");
    expect(() => evaluate(verify, [root, sourceRoot])).toThrow(
      /not bounded regular data/u,
    );
    rmSync(artifact);
    execFileSync("mkfifo", [artifact]);
    expect(() => evaluate(verify, [root, sourceRoot])).toThrow(
      /not bounded regular data/u,
    );
  });

  it("rejects replacement of a pinned acquisition parent", () => {
    const root = temporaryRoot();
    const destination = resolve(root, "destination");
    const detached = resolve(root, "detached");
    const substituted = resolve(root, "substituted");
    mkdirSync(destination, { mode: 0o700 });
    mkdirSync(substituted, { mode: 0o700 });
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import {openPrivateDirectory,writePinnedPayload} from ${JSON.stringify(acquisitionUrl)}; import {renameSync,symlinkSync,closeSync} from 'node:fs'; const a=openPrivateDirectory(process.argv[1]); renameSync(process.argv[1],process.argv[2]); symlinkSync(process.argv[3],process.argv[1]); try { writePinnedPayload(a,'canary.apk',Buffer.from('canary')); } finally { closeSync(a.descriptor); }`,
          destination,
          detached,
          substituted,
        ],
        { stdio: "pipe", timeout: 10_000 },
      ),
    ).toThrow(/destination identity changed/u);
    expect(readdirSync(detached)).toEqual([]);
    expect(readdirSync(substituted)).toEqual([]);
  });

  it("pins the bounded 19-archive acquisition plan", () => {
    const output = evaluate(
      `const {validatePtyToolchainPolicy}=await import(${JSON.stringify(acquisitionUrl)}); process.stdout.write(JSON.stringify(validatePtyToolchainPolicy()));`,
    );
    const records = JSON.parse(output) as Array<{
      bytes: number;
      url: string;
    }>;
    expect(records).toHaveLength(19);
    expect(records.reduce((sum, record) => sum + record.bytes, 0)).toBe(
      97_592_935,
    );
    expect(records.every(({ url }) => url.startsWith("https://"))).toBe(true);
  });
});

// The closed build-material table intentionally keeps every authority
// substitution next to the exact positive oracle.
// eslint-disable-next-line max-lines-per-function
describe("PTY authenticated build-material tooling", () => {
  const inspect = (
    fixture: ReturnType<typeof syntheticPackage>,
    record = fixture.record,
    publicKey = fixture.publicKey,
  ) =>
    evaluate(
      `const m=await import(${JSON.stringify(acquisitionUrl)}); const bytes=Buffer.from(process.argv[1],'base64'); const record=JSON.parse(process.argv[2]); const result=m.inspectAuthenticatedPackage(bytes,record,process.argv[3]); process.stdout.write(JSON.stringify({dataEntries:result.dataEntries.map(({contents,...entry})=>({...entry,contents:contents.toString('base64')}))}));`,
      [fixture.bytes.toString("base64"), JSON.stringify(record), publicKey],
    );

  it("authenticates package signatures, metadata, and closed member inventories", () => {
    const fixture = syntheticPackage();
    expect(() => inspect(fixture)).not.toThrow();
    const unrelatedKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    expect(() => inspect(fixture, fixture.record, unrelatedKey)).toThrow(
      /signature authority failed/u,
    );
    expect(() =>
      inspect(fixture, { ...fixture.record, name: "substituted" }),
    ).toThrow(/metadata is not exact/u);
    expect(() =>
      inspect(fixture, { ...fixture.record, inventory: "0".repeat(64) }),
    ).toThrow(/member inventory is not exact/u);
  });

  it("rejects signed-index mapping and installed-member substitutions", () => {
    const fixture = syntheticPackage();
    const index = [
      "P:canary",
      "V:1-r0",
      "A:x86_64",
      `C:${fixture.record.signedIndexChecksum}`,
      `S:${fixture.record.bytes}`,
      "",
    ].join("\n");
    const verifyIndex = (text: string) =>
      evaluate(
        `const m=await import(${JSON.stringify(acquisitionUrl)}); m.verifySignedIndexRecords(process.argv[1],[JSON.parse(process.argv[2])]);`,
        [text, JSON.stringify(fixture.record)],
      );
    expect(() => verifyIndex(index)).not.toThrow();
    expect(() => verifyIndex(index.replace("A:x86_64", "A:aarch64"))).toThrow(
      /signed index mapping changed/u,
    );
    const root = temporaryRoot();
    evaluate(
      `const m=await import(${JSON.stringify(acquisitionUrl)}); const bytes=Buffer.from(process.argv[1],'base64'); const record=JSON.parse(process.argv[2]); const inspected=m.inspectAuthenticatedPackage(bytes,record,process.argv[3]); m.installPackageClosure([{...inspected,record}],process.argv[4]);`,
      [
        fixture.bytes.toString("base64"),
        JSON.stringify(fixture.record),
        fixture.publicKey,
        root,
      ],
    );
    chmodSync(resolve(root, "usr/bin/canary"), 0o700);
    expect(() =>
      evaluate(
        `const m=await import(${JSON.stringify(acquisitionUrl)}); const bytes=Buffer.from(process.argv[1],'base64'); const record=JSON.parse(process.argv[2]); const inspected=m.inspectAuthenticatedPackage(bytes,record,process.argv[3]); m.verifyInstalledPackageClosure([{...inspected,record}],process.argv[4]);`,
        [
          fixture.bytes.toString("base64"),
          JSON.stringify(fixture.record),
          fixture.publicKey,
          root,
        ],
      ),
    ).toThrow(/toolchain authority is not exact/u);
  });

  it("stages build output at the exact admitted mode", () => {
    const root = temporaryRoot();
    const source = resolve(root, "source.node");
    const destination = resolve(root, "destination.node");
    writeFileSync(source, "synthetic-not-loaded");
    chmodSync(source, 0o400);
    evaluate(
      `const {stageBuiltRuntime}=await import(${JSON.stringify(buildUrl)}); stageBuiltRuntime(process.argv[1],process.argv[2]);`,
      [source, destination],
    );
    expect(statSync(destination).mode & 0o777).toBe(0o644);
    expect(readFileSync(destination, "utf8")).toBe("synthetic-not-loaded");
  });

  it("creates one exact private compiler temporary root", () => {
    const root = temporaryRoot();
    evaluate(
      `const {createPrivateBuildTemp}=await import(${JSON.stringify(buildUrl)}); const path=createPrivateBuildTemp(process.argv[1]); process.stdout.write(path);`,
      [root],
    );
    const temporary = resolve(root, "tmp");
    expect(statSync(temporary).isDirectory()).toBe(true);
    expect(statSync(temporary).mode & 0o777).toBe(0o700);
    expect(() =>
      evaluate(
        `const {createPrivateBuildTemp}=await import(${JSON.stringify(buildUrl)}); createPrivateBuildTemp(process.argv[1]);`,
        [root],
      ),
    ).toThrow(/already exists/iu);
  });

  it("accepts only the exact canonical build paths", () => {
    expect(
      evaluate(
        `const {verifyCanonicalBuildPaths}=await import(${JSON.stringify(buildUrl)}); process.stdout.write(JSON.stringify(verifyCanonicalBuildPaths({output:process.argv[1],sourceRoot:process.argv[2]})));`,
        ["/output", "/build"],
      ),
    ).toBe(
      JSON.stringify({
        addonApi: "/build/node-addon-api",
        destination: "/output/pty.node",
        patch: "/build/node-pty/patches/agentscope-terminal-authority.patch",
        source: "/build/node-pty/src/unix/pty.cc",
      }),
    );
    expect(() =>
      evaluate(
        `const {verifyCanonicalBuildPaths}=await import(${JSON.stringify(buildUrl)}); verifyCanonicalBuildPaths({output:process.argv[1],sourceRoot:process.argv[2]});`,
        ["/output", "/substituted-build"],
      ),
    ).toThrow(/sources are not at canonical build paths/iu);
  });

  it("applies only the exact bounded PTY authority patch without fuzz", () => {
    const source = readFileSync(
      resolve(packageRoot, "../../third_party/node-pty/src/unix/pty.cc"),
      "utf8",
    );
    const patch = readFileSync(
      resolve(
        packageRoot,
        "../../third_party/node-pty/patches/agentscope-terminal-authority.patch",
      ),
      "utf8",
    );
    const apply = (candidateSource: string, candidatePatch: string) =>
      evaluate(
        `const {createHash}=await import('node:crypto'); const {applyExactPtyPatch}=await import(${JSON.stringify(buildUrl)}); const result=applyExactPtyPatch(Buffer.from(process.argv[1],'base64').toString(),Buffer.from(process.argv[2],'base64').toString()); process.stdout.write(createHash('sha256').update(result).digest('hex'));`,
        [
          Buffer.from(candidateSource).toString("base64"),
          Buffer.from(candidatePatch).toString("base64"),
        ],
      );
    expect(apply(source, patch)).toBe(
      "b57b7a2171826869f4d6a299ccad32bd639ed89c4dcda5cd7c6e9a35dd4f9e84",
    );
    expect(() => apply(source, patch.replace("-21,6", "-22,6"))).toThrow(
      /position|context/u,
    );
    expect(() =>
      apply(source.replace("#include <napi.h>", "#include <hostile.h>"), patch),
    ).toThrow(/context/u);
    expect(() =>
      apply(source, patch.replace("a/src/unix/pty.cc", "../../hostile/pty.cc")),
    ).toThrow(/paths/u);
    expect(() => apply(source, `${patch}--- a/extra\n+++ b/extra\n`)).toThrow(
      /hunk header|position/u,
    );
    expect(() =>
      apply(source, patch.replace("@@ -21,6", "@@ malformed")),
    ).toThrow(/hunk header/u);
  });
});
