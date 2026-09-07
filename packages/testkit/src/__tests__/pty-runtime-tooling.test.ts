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
  realpathSync,
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

const runtimeReceipt = (value: unknown) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value) !==
      '{"deadlineNoLaunch":true,"descriptorClosure":true,"faults":true,"geometry":true,"happy":true,"openRollback":true,"residual":true}'
  )
    throw new Error("PTY runtime proof receipt is not exact.");
};

const runtimeFixture = `import {fstatSync} from "node:fs";
let extraOpen=true;try{fstatSync(Number(process.env.EXTRA_FD));}catch{extraOpen=false;}
process.stdout.write(JSON.stringify({columns:process.stdout.columns,extraOpen,isTTY:process.stdin.isTTY===true&&process.stdout.isTTY===true,rows:process.stdout.rows})+"\\n");
process.stdin.resume();process.stdin.on("end",()=>process.exit(0));\n`;

const runtimeDriver = `import {createRequire} from "node:module";
import {closeSync,constants,fstatSync,openSync,readdirSync,readFileSync} from "node:fs";
if(process.versions.modules!=="127"||readFileSync("/etc/alpine-release","utf8").trim()!=="3.24.1")throw new Error("canonical runtime identity mismatch");
const require=createRequire(import.meta.url);const production=require("/runtime/production.node");const faults=require("/runtime/faults.node");
const fixture="/fixture/fixture.mjs";const environment=extra=>[\`EXTRA_FD=\${extra}\`,"LANG=C","LC_ALL=C","PATH=/usr/local/bin:/usr/bin:/bin","TZ=UTC"];
const pair=()=>({interpreter:openSync("/usr/local/bin/node",constants.O_RDONLY|constants.O_NOFOLLOW),script:openSync(fixture,constants.O_RDONLY|constants.O_NOFOLLOW)});
const invoke=(addon,{fault=0,milliseconds=2000}={})=>{const p=pair();const extra=openSync("/dev/null",constants.O_RDONLY|constants.O_NOFOLLOW);let exit;addon.testFault?.(fault);try{return{extra,p,result:addon.fork(p.interpreter,p.script,[],environment(extra),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+BigInt(milliseconds)*1000000n,(code,signal)=>{exit={code,signal};}),exit:()=>exit};}catch(error){closeSync(p.interpreter);closeSync(p.script);closeSync(extra);throw error;}};
const fails=(fault,pattern,milliseconds)=>{let message="";try{invoke(faults,{fault,milliseconds});}catch(error){message=String(error);}if(!pattern.test(message))throw new Error("fault receipt mismatch");};
fails(0,/deadline is invalid or expired/,-1);fails(1<<9,/expired before launch/,20);fails((1<<8)|(1<<7),/stage 5 errno 5.*child joined/,50);for(const bit of [1,2,3,4,7])fails(1<<bit,/failed|invalid|pre-handoff|child joined/);for(const bit of [6,12])fails((1<<bit)|(1<<7),/cleanup uncertain/);
const beforeOpen=readdirSync("/proc/self/fd").length;for(const bit of [10,11]){faults.testFault(1<<bit);let rejected=false;try{faults.open(80,24,process.hrtime.bigint()+2000000000n);}catch{rejected=true;}if(!rejected)throw new Error("open rollback accepted");}const openRollback=readdirSync("/proc/self/fd").length===beforeOpen;
const live=invoke(faults);closeSync(live.p.interpreter);closeSync(live.p.script);closeSync(live.extra);const first=faults.inspect(live.result.handle);faults.resize(live.result.handle,91,31,0,0);const resized=faults.inspect(live.result.handle);faults.write(live.result.handle,Buffer.from("hello\\n"));faults.eof(live.result.handle);let output="";const end=Date.now()+2000;while(Date.now()<end){const observed=faults.read(live.result.handle,4096);if(observed.status==="data")output+=observed.bytes.toString();if((observed.status==="eof"||observed.status==="eio")&&live.exit())break;await new Promise(resolve=>setTimeout(resolve,10));}faults.close(live.result.handle);
const happyPair=pair();let happyExit;const happy=production.fork(happyPair.interpreter,happyPair.script,[],environment(-1),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+2000000000n,(code,signal)=>{happyExit={code,signal};});closeSync(happyPair.interpreter);closeSync(happyPair.script);production.eof(happy.handle);const happyEnd=Date.now()+2000;while(Date.now()<happyEnd&&!happyExit){production.read(happy.handle,4096);await new Promise(resolve=>setTimeout(resolve,10));}production.close(happy.handle);
const residual=readFileSync("/proc/self/task/1/children","utf8").trim()==="";const receipt={deadlineNoLaunch:true,descriptorClosure:output.includes('"extraOpen":false'),faults:true,geometry:first.isTTY===true&&resized.columns===91&&resized.rows===31,happy:happyExit?.code===0,openRollback,residual};process.stdout.write(JSON.stringify(receipt));\n`;
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

// Runtime authority and its hostile artifact cases stay in one adjacent table.
// eslint-disable-next-line max-lines-per-function
describe("PTY runtime artifact tooling", () => {
  it("replays the closed PTY ABI matrix only on authenticated GitHub CI", () => {
    const identity = {
      actions: process.env.GITHUB_ACTIONS,
      event: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
      runnerArch: process.env.RUNNER_ARCH,
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      runnerOs: process.env.RUNNER_OS,
      workspace: process.env.GITHUB_WORKSPACE,
    };
    const indicators = Object.values(identity).filter(
      (value) => value !== undefined,
    );
    if (indicators.length === 0) {
      expect(() => {
        runtimeReceipt({
          deadlineNoLaunch: true,
          descriptorClosure: true,
          faults: true,
          geometry: true,
          happy: true,
          openRollback: true,
          residual: true,
        });
      }).not.toThrow();
      expect(() => {
        runtimeReceipt({ happy: true });
      }).toThrow(/receipt is not exact/u);
      return;
    }
    expect(identity).toEqual({
      actions: "true",
      event: "pull_request",
      repository: "Melbourneandrew/agentscope",
      runnerArch: "X64",
      runnerEnvironment: "github-hosted",
      runnerOs: "Linux",
      workspace: realpathSync(resolve(packageRoot, "../..")),
    });
    const docker = "/usr/bin/docker";
    const dockerStat = statSync(docker);
    expect(dockerStat.isFile()).toBe(true);
    expect(dockerStat.uid).toBe(0);
    expect(dockerStat.mode & 0o111).not.toBe(0);
    const socket = statSync("/var/run/docker.sock");
    expect(socket.isSocket()).toBe(true);
    const root = temporaryRoot();
    const configuration = resolve(root, "docker-config");
    const fixture = resolve(root, "fixture.mjs");
    const driver = resolve(root, "driver.mjs");
    mkdirSync(configuration, { mode: 0o700 });
    chmodSync(configuration, 0o700);
    writeFileSync(fixture, runtimeFixture, { mode: 0o400 });
    writeFileSync(driver, runtimeDriver, { mode: 0o400 });
    const output = execFileSync(
      docker,
      [
        "--config",
        configuration,
        "--host",
        "unix:///var/run/docker.sock",
        "run",
        "--rm",
        "--network",
        "none",
        "--platform",
        "linux/amd64",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,mode=0700",
        "--mount",
        `type=bind,src=${resolve(packageRoot, "pty-runtime/node127-linux-x64-musl/pty.node")},dst=/runtime/production.node,readonly`,
        "--mount",
        `type=bind,src=${resolve(packageRoot, "fixtures/pty-runtime-faults/node127-linux-x64-musl/pty.node")},dst=/runtime/faults.node,readonly`,
        "--mount",
        `type=bind,src=${fixture},dst=/fixture/fixture.mjs,readonly`,
        "--mount",
        `type=bind,src=${driver},dst=/fixture/driver.mjs,readonly`,
        "node@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c",
        "node",
        "--expose-gc",
        "/fixture/driver.mjs",
      ],
      {
        encoding: "utf8",
        env: {
          DOCKER_API_VERSION: "1.44",
          HOME: root,
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    runtimeReceipt(JSON.parse(output));
  });

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

  it("rejects substitution of the non-staged fault artifact", () => {
    const root = temporaryRoot();
    mkdirSync(resolve(root, "pty-runtime/node127-linux-x64-musl"), {
      recursive: true,
    });
    mkdirSync(
      resolve(root, "fixtures/pty-runtime-faults/node127-linux-x64-musl"),
      { recursive: true },
    );
    for (const file of [
      "pty-runtime-artifacts.json",
      "pty-runtime-policy.json",
    ])
      copyFileSync(resolve(packageRoot, file), resolve(root, file));
    copyFileSync(
      resolve(packageRoot, "pty-runtime/node127-linux-x64-musl/pty.node"),
      resolve(root, "pty-runtime/node127-linux-x64-musl/pty.node"),
    );
    writeFileSync(
      resolve(
        root,
        "fixtures/pty-runtime-faults/node127-linux-x64-musl/pty.node",
      ),
      "substituted",
    );
    const verify = `const {verifyPtyRuntime}=await import(${JSON.stringify(verifierUrl)}); verifyPtyRuntime({root:process.argv[1],sourceRoot:process.argv[2]});`;
    expect(() =>
      evaluate(verify, [root, resolve(packageRoot, "../..")]),
    ).toThrow(/test-fault artifact bytes do not match authority/u);
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
      "7f0a15d54a4fdcc1e2fab2663e6cad0fac1011e331a1df998141560b5a9be4d6",
    );
    expect(() => apply(source, patch.replace("-22,0", "-23,0"))).toThrow(
      /position|context/u,
    );
    expect(() =>
      apply(source.replace("#include <napi.h>", "#include <hostile.h>"), patch),
    ).toThrow(/context|identity/u);
    expect(() =>
      apply(source, patch.replace("a/src/unix/pty.cc", "../../hostile/pty.cc")),
    ).toThrow(/paths/u);
    expect(() => apply(source, `${patch}--- a/extra\n+++ b/extra\n`)).toThrow(
      /hunk header|position/u,
    );
    expect(() =>
      apply(source, patch.replace("@@ -22,0", "@@ malformed")),
    ).toThrow(/hunk header/u);
    expect(() => apply(`${"x".repeat(65_536)}\n`, patch)).toThrow(
      /byte bound/u,
    );
    expect(() => apply(source, `${patch}${"+x\n".repeat(2_049)}`)).toThrow(
      /byte bound|line authority|operation inventory/u,
    );
    expect(() =>
      apply(
        source,
        patch.replace("+#include <atomic>", `+${"x".repeat(2_049)}`),
      ),
    ).toThrow(/byte bound|line authority/u);
    expect(() =>
      apply(source, patch.replace(",0 +", ",999999999999 +")),
    ).toThrow(/hunk counts|incomplete|position/u);
    expect(patch).toContain(
      "+    errno = 0;\n+    entry = readdir(directory);",
    );
    expect(patch).toContain("+    errno = EINVAL;");
    expect(() =>
      apply(source, patch.replace("+    errno = 0;", "+    errno = EIO;")),
    ).toThrow(/identity/u);
    expect(() =>
      apply(
        source,
        patch.replace("+      if (errno != 0)", "+      if (errno == EIO)"),
      ),
    ).toThrow(/identity/u);
  });

  // All mutation oracles remain adjacent to the one exact positive patch.
  // eslint-disable-next-line max-lines-per-function
  it("pins deadline, descriptor, cleanup, and close authority", () => {
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
    const apply = (candidatePatch: string) =>
      evaluate(
        `const {applyExactPtyPatch}=await import(${JSON.stringify(buildUrl)}); applyExactPtyPatch(Buffer.from(process.argv[1],'base64').toString(),Buffer.from(process.argv[2],'base64').toString());`,
        [
          Buffer.from(source).toString("base64"),
          Buffer.from(candidatePatch).toString("base64"),
        ],
      );
    expect(patch).toContain(
      "+          fcntl(interpreter_fd, F_SETFD, interpreter_flags & ~FD_CLOEXEC) == -1 ||",
    );
    expect(patch).toContain(
      "+          fcntl(script_fd, F_SETFD, script_flags & ~FD_CLOEXEC) == -1)",
    );
    expect(patch).toContain(
      "+      (interpreter_descriptor_flags & FD_CLOEXEC) == 0 ||",
    );
    expect(patch).toContain(
      "+      (script_descriptor_flags & FD_CLOEXEC) == 0 ||",
    );
    expect(patch).toContain(
      "+  uint64_t deadline = info[11].As<Napi::BigInt>().Uint64Value(&deadline_lossless);",
    );
    expect(patch).toContain(
      "+    int remaining = pty_remaining_milliseconds(deadline);",
    );
    expect(patch).toContain(
      "+        bool settled = pty_join_failed_child(pid, &master, &exec_status[0], deadline);",
    );
    expect(patch).toContain("+#if defined(AGENTSCOPE_PTY_TEST_FAULTS)");
    expect(patch).toContain("+  handle->fd = -1;");
    expect(patch).toContain("+  handle->generation = 0;");
    expect(patch).toContain("+  uint64_t deadline;");
    expect(patch).toContain(
      "+       pty_remaining_milliseconds(handle->deadline) == 0))",
    );
    expect(patch).toContain(
      "+  TerminalHandle *handle = require_terminal_handle(env, info[0], false);",
    );
    expect(patch).toContain("+        candidate == exec_status_fd ||");
    expect(patch).toContain(
      "+  if (pty_remaining_milliseconds(deadline) == 0) {",
    );
    expect(patch).toContain(
      "+  std::thread **thread_slot = new std::thread *(nullptr);",
    );
    expect(patch).toContain(
      "+    if (tsfn_created && tsfn.Release() != napi_ok)",
    );
    expect(patch).toContain("+  TerminalHandle *master_handle = nullptr;");
    expect(patch).toContain("+  TerminalHandle *slave_handle = nullptr;");
    expect(() =>
      apply(
        patch.replace(
          "interpreter_flags & ~FD_CLOEXEC",
          "interpreter_flags | FD_CLOEXEC",
        ),
      ),
    ).toThrow(/identity/u);
    expect(() =>
      apply(
        patch.replace(
          "candidate == exec_status_fd ||",
          "candidate == directory_fd ||",
        ),
      ),
    ).toThrow(/identity/u);
    for (const [needle, replacement] of [
      [
        "(interpreter_descriptor_flags & FD_CLOEXEC) == 0",
        "interpreter_descriptor_flags == -2",
      ],
      [
        "(script_descriptor_flags & FD_CLOEXEC) == 0",
        "script_descriptor_flags == -2",
      ],
      [
        "pty_exec_succeeded(exec_status[0], deadline, &failure)",
        "pty_exec_succeeded(exec_status[0], UINT64_MAX, &failure)",
      ],
      [
        "pty_join_failed_child(pid, &master, &exec_status[0], deadline)",
        "pty_join_failed_child(pid, nullptr, nullptr, deadline)",
      ],
      ["handle->fd = -1;", "handle->fd = fd;"],
      [
        "pty_remaining_milliseconds(handle->deadline) == 0",
        "pty_remaining_milliseconds(UINT64_MAX) == 0",
      ],
      [
        "#if defined(AGENTSCOPE_PTY_TEST_FAULTS)",
        "#if defined(AGENTSCOPE_PTY_FAULTS)",
      ],
      [
        "pty_remaining_milliseconds(deadline) == 0) {",
        "pty_remaining_milliseconds(UINT64_MAX) == 0) {",
      ],
      [
        "tsfn_created && tsfn.Release() != napi_ok",
        "tsfn_created && napi_ok != napi_ok",
      ],
      [
        "TerminalHandle *slave_handle = nullptr;",
        "TerminalHandle *slave_handle = master_handle;",
      ],
    ] as const) {
      expect(() => apply(patch.replace(needle, replacement))).toThrow(
        /identity/u,
      );
    }
  });
});
