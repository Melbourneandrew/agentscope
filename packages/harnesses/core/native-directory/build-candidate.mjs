/** Trusted candidate job only; never imported by an ordinary package build. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { componentProof } from "./component-proof.mjs";
import { assertToolchainImageAuthority } from "../../../destinations/local-sqlite/native-candidate/tooling/image-platform-authority.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const source = fileURLToPath(new URL("primitive.c", import.meta.url));
const headerNames = Object.freeze([
  "js_native_api.h",
  "js_native_api_types.h",
  "node_api.h",
  "node_api_types.h",
]);
const xcode = "/Applications/Xcode_16.2.app";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = () => {
  throw new Error("harness.directory.candidate-invalid");
};
const canonical = (value) => JSON.stringify(value);

const readExact = (path, maximum = 1_048_576) => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) {
      if (path === `${xcode}/Contents/_CodeSignature/CodeResources`)
        throw new Error(
          `harness.directory.candidate-invalid:resource-seal:regular=${before.isFile()}:nonempty=${before.size > 0n}:bytes=${before.size}:cap=${maximum}`,
        );
      fail();
    }
    const value = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < value.length) {
      const count = readSync(fd, value, offset, value.length - offset, null);
      if (count < 1) fail();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) fail();
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    for (const key of [
      "dev",
      "ino",
      "size",
      "mode",
      "nlink",
      "mtimeNs",
      "ctimeNs",
    ])
      if (before[key] !== after[key] || after[key] !== named[key]) fail();
    return value;
  } finally {
    closeSync(fd);
  }
};

export const candidateProfile = (row) => {
  if (row === "linux-x64")
    return Object.freeze({
      platform: "linux",
      architecture: "x64",
      minimumOsVersion: "5.15",
      libcFamily: "glibc",
      minimumLibcVersion: "2.34",
      admittedNodeMajors: [22],
    });
  if (row === "darwin-arm64")
    return Object.freeze({
      platform: "darwin",
      architecture: "arm64",
      minimumOsVersion: "11.0",
      libcFamily: null,
      minimumLibcVersion: null,
      admittedNodeMajors: [22],
    });
  return fail();
};

export const compilerArguments = (row, sdk, headers, output) => {
  candidateProfile(row);
  if (
    ![headers, output].every(
      (path) => isAbsolute(path) && resolve(path) === path,
    ) ||
    (row === "darwin-arm64" &&
      (!isAbsolute(sdk) ||
        resolve(sdk) !== sdk ||
        !sdk.startsWith(`${xcode}/Contents/Developer/`))) ||
    (row === "linux-x64" && sdk !== null)
  )
    fail();
  const common = [
    "-std=c11",
    "-O2",
    "-fPIC",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I",
    headers,
  ];
  return Object.freeze(
    row === "darwin-arm64"
      ? [
          ...common,
          "-arch",
          "arm64",
          "-isysroot",
          sdk,
          "-mmacosx-version-min=11.0",
          "-bundle",
          "-undefined",
          "dynamic_lookup",
          source,
          "-o",
          output,
        ]
      : [...common, "-shared", source, "-o", output],
  );
};

const within = (parent, path) => {
  const suffix = relative(parent, path);
  return suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix);
};
const observation = (path, maximum) => {
  const bytes = readExact(path, maximum);
  return Object.freeze({ bytes: bytes.length, digest: `sha256:${sha(bytes)}` });
};

const runFactory = (deadline) => (executable, argv) => {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) return fail();
  return execFileSync(executable, argv, {
    cwd: root,
    timeout: remaining,
    maxBuffer: 1_048_576,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  });
};

const imageProof = () => {
  const material = JSON.parse(
    readExact(
      join(
        root,
        "packages/destinations/local-sqlite/native-candidate/files/records/release-materials.json",
      ),
    ),
  );
  const selected = material.toolchainClosure.selectedManifest;
  const proof = {
    sourceIndex: material.toolchainClosure.image,
    selectedManifest: selected.reference,
    selectedManifestBytes: selected.bytes,
    configDigest: selected.configDigest,
    configBytes: selected.configBytes,
    rawIndexGzipBase64: selected.rawIndexGzipBase64,
    rawManifestGzipBase64: selected.rawManifestGzipBase64,
    platform: selected.platform,
  };
  assertToolchainImageAuthority(proof);
  return Object.freeze(proof);
};

const linuxMaterials = (run, headersRoot, context) => {
  if (
    process.versions.node !== "22.18.0" ||
    process.execPath !== "/usr/local/bin/node"
  )
    fail();
  const proof = imageProof();
  const headerFiles = [];
  for (const name of headerNames) {
    const bytes = readExact(`/usr/local/include/node/${name}`, 131_072);
    writeFileSync(join(headersRoot, name), bytes, { flag: "wx", mode: 0o600 });
    headerFiles.push({
      name,
      bytes: bytes.length,
      digest: `sha256:${sha(bytes)}`,
    });
  }
  const license = readExact("/usr/local/LICENSE", 262_144);
  writeFileSync(join(headersRoot, "node-MIT.txt"), license, {
    flag: "wx",
    mode: 0o600,
  });
  const transfer = {
    schemaVersion: 1,
    ...context,
    imageProof: proof,
    headerFiles,
    license: { bytes: license.length, digest: `sha256:${sha(license)}` },
  };
  writeFileSync(join(headersRoot, "material.json"), canonical(transfer), {
    flag: "wx",
    mode: 0o600,
  });
  const compiler = realpathSync("/usr/bin/cc");
  if (
    !within("/usr/bin", compiler) ||
    !run(compiler, ["-dumpfullversion"]).trim().startsWith("12.2.")
  )
    fail();
  return {
    compiler,
    sdk: null,
    material: {
      kind: "pinned-node-image",
      ...transfer,
      compiler: { path: compiler, ...observation(compiler, 16_777_216) },
    },
  };
};

const darwinMaterials = (run, headersRoot, context) => {
  // Apple seal first. No SDK/compiler file is read before this verification.
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "-R",
    "=anchor apple",
    xcode,
  ]);
  const transfer = JSON.parse(
    readExact(join(headersRoot, "material.json"), 65_536),
  );
  if (
    transfer.schemaVersion !== 1 ||
    transfer.runId !== context.runId ||
    transfer.sourceCommit !== context.sourceCommit ||
    !Array.isArray(transfer.headerFiles) ||
    transfer.headerFiles.length !== headerNames.length
  )
    fail();
  assertToolchainImageAuthority(transfer.imageProof);
  for (let index = 0; index < headerNames.length; index += 1) {
    const file = transfer.headerFiles[index];
    const actual = observation(join(headersRoot, headerNames[index]), 131_072);
    if (
      file.name !== headerNames[index] ||
      canonical(actual) !==
        canonical({ bytes: file.bytes, digest: file.digest })
    )
      fail();
  }
  if (
    canonical(observation(join(headersRoot, "node-MIT.txt"), 262_144)) !==
    canonical(transfer.license)
  )
    fail();
  const developer = `${xcode}/Contents/Developer`;
  const compiler = realpathSync(
    `${developer}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang`,
  );
  const linker = realpathSync(
    `${developer}/Toolchains/XcodeDefault.xctoolchain/usr/bin/ld`,
  );
  const sdk = realpathSync(
    `${developer}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.2.sdk`,
  );
  if (![compiler, linker, sdk].every((path) => within(developer, path))) fail();
  return {
    compiler,
    sdk,
    material: {
      kind: "apple-sealed-xcode",
      ...transfer,
      xcodePath: xcode,
      appleSealVerified: true,
      resourceSeal: observation(
        `${xcode}/Contents/_CodeSignature/CodeResources`,
        16_777_216,
      ),
      compiler: { path: compiler, ...observation(compiler, 268_435_456) },
      linker: { path: linker, ...observation(linker, 268_435_456) },
      sdkPath: sdk,
      sdkSettings: observation(join(sdk, "SDKSettings.json"), 262_144),
    },
  };
};

const dependencyInputs = (run, compiler, args, roots) => {
  const compile = args
    .slice(0, args.indexOf("-o"))
    .filter(
      (value) =>
        !["-shared", "-bundle", "-undefined", "dynamic_lookup"].includes(value),
    );
  const output = run(compiler, [...compile, "-M", "-MT", "directory"]);
  const fields = output.replaceAll("\\\n", " ").trim().split(/\s+/u);
  if (
    fields.shift() !== "directory:" ||
    fields.length < 1 ||
    fields.length > 128
  )
    fail();
  const paths = [...new Set(fields)].sort();
  return paths.map((path) => {
    if (!isAbsolute(path)) fail();
    const absolute = realpathSync(path);
    if (
      absolute !== source &&
      !roots.some((parent) => within(parent, absolute))
    )
      fail();
    return { path: absolute, ...observation(absolute, 1_048_576) };
  });
};

const sealedSdkInputs = (run, inputs, outputRoot) => {
  const projected = join(outputRoot, "resource-seal.xml");
  run("/usr/bin/plutil", [
    "-extract",
    "files2",
    "xml1",
    "-o",
    projected,
    `${xcode}/Contents/_CodeSignature/CodeResources`,
  ]);
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(
    readExact(projected, 67_108_864),
  );
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const input of inputs.filter((value) =>
    within(`${xcode}/Contents`, value.path),
  )) {
    const path = relative(`${xcode}/Contents`, input.path);
    if (/[<&]/u.test(path)) fail();
    const records = [
      ...xml.matchAll(
        new RegExp(
          `<key>${escaped(path)}</key>\\s*<dict>([\\s\\S]*?)</dict>`,
          "gu",
        ),
      ),
    ];
    if (records.length !== 1) fail();
    const hashes = [
      ...records[0][1].matchAll(
        /<key>hash2<\/key>\s*<data>([A-Za-z0-9+/=\s]+)<\/data>/gu,
      ),
    ];
    if (hashes.length !== 1) fail();
    const encoded = hashes[0][1].replace(/\s/gu, "");
    const hash = Buffer.from(encoded, "base64");
    if (
      hash.length !== 32 ||
      hash.toString("base64") !== encoded ||
      `sha256:${hash.toString("hex")}` !== input.digest
    )
      fail();
  }
};

const inspectCandidate = (run, row, output) => {
  const inspection =
    row === "linux-x64"
      ? run("/usr/bin/readelf", ["-h", "-d", "--version-info", output])
      : run(
          `${xcode}/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/otool`,
          ["-l", "-L", output],
        );
  const dependencies = [
    ...inspection.matchAll(
      row === "linux-x64"
        ? /\(NEEDED\).*\[([^\]]+)\]/gu
        : /name (\S+) \(offset/gu,
    ),
  ].map((match) => match[1]);
  const glibcVersions = [
    ...new Set(
      [...inspection.matchAll(/GLIBC_([0-9]+\.[0-9]+)/gu)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
  const staticFacts = {
    format: row === "linux-x64" ? "ELF" : "Mach-O",
    dependencies,
    glibcVersions,
    minimumOsVersion:
      row === "darwin-arm64" ? inspection.match(/minos (\S+)/u)?.[1] : null,
  };
  if (dependencies.length > 16 || glibcVersions.length > 64) fail();
  if (row === "linux-x64") {
    if (
      !inspection.includes("Advanced Micro Devices X86-64") ||
      [...inspection.matchAll(/\(NEEDED\).*\[([^\]]+)\]/gu)].some(
        (match) => match[1] !== "libc.so.6",
      ) ||
      [...inspection.matchAll(/GLIBC_([0-9]+)\.([0-9]+)/gu)].some(
        (match) =>
          Number(match[1]) > 2 ||
          (Number(match[1]) === 2 && Number(match[2]) > 34),
      )
    )
      fail();
  } else {
    if (
      !/cmd LC_BUILD_VERSION/u.test(inspection) ||
      !/minos 11\.0(?:\s|$)/u.test(inspection) ||
      [...inspection.matchAll(/name (\S+) \(offset/gu)].some(
        (match) => match[1] !== "/usr/lib/libSystem.B.dylib",
      )
    )
      fail();
    run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      "=anchor apple",
      xcode,
    ]);
  }
  return { inspection, staticFacts };
};

export const buildCandidate = (row) => {
  const entry = performance.now();
  const deadline = entry + 300_000;
  const profile = candidateProfile(row);
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.platform !== profile.platform ||
    process.arch !== profile.architecture ||
    Number(process.versions.node.split(".")[0]) !== 22 ||
    !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "") ||
    !/^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ID ?? "")
  )
    fail();
  const context = {
    sourceCommit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
  };
  const stage = join(root, "artifacts/directory-native");
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const outputRoot = join(stage, row);
  mkdirSync(outputRoot, { mode: 0o700 });
  const headersRoot = join(stage, "headers");
  if (row === "linux-x64") mkdirSync(headersRoot, { mode: 0o700 });
  const run = runFactory(deadline);
  const selected =
    row === "linux-x64"
      ? linuxMaterials(run, headersRoot, context)
      : darwinMaterials(run, headersRoot, context);
  const output = join(outputRoot, "directory.node");
  const argv = compilerArguments(row, selected.sdk, headersRoot, output);
  const inputs = dependencyInputs(
    run,
    selected.compiler,
    argv,
    row === "linux-x64"
      ? [headersRoot, "/usr/include", "/usr/lib/gcc"]
      : [headersRoot, xcode],
  );
  if (row === "darwin-arm64") sealedSdkInputs(run, inputs, outputRoot);
  run(selected.compiler, argv);
  const { inspection, staticFacts } = inspectCandidate(run, row, output);
  componentProof(output, join(outputRoot, "proof-directory"));
  if (performance.now() >= deadline) fail();
  const record = {
    schemaVersion: 1,
    disposition: "unadmitted-candidate",
    ...context,
    profile,
    primitiveSourceDigest: `sha256:${sha(readExact(source, 65_536))}`,
    driverSourceDigest: `sha256:${sha(readExact(fileURLToPath(import.meta.url), 65_536))}`,
    workflowSourceDigest: `sha256:${sha(readExact(join(root, ".github/workflows/directory-native-candidate.yml"), 65_536))}`,
    material: selected.material,
    inputs,
    compilerArguments: argv,
    binary: observation(output, 16_777_216),
    staticInspectionDigest: `sha256:${sha(inspection)}`,
    staticFacts,
    componentProof: "passed",
    elapsedMilliseconds: Math.ceil(performance.now() - entry),
  };
  writeFileSync(
    join(outputRoot, "observed-materials.json"),
    canonical(record),
    { flag: "wx", mode: 0o600 },
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) fail();
  buildCandidate(process.argv[2]);
}
