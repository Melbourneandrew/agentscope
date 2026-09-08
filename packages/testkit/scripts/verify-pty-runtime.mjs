import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const maximumArtifactBytes = 2 * 1024 * 1024;
const expectedArtifact = Object.freeze({
  bytes: 631_176,
  needed: Object.freeze(["libc.musl-x86_64.so.1"]),
  path: "pty-runtime/node127-linux-x64-musl/pty.node",
  sha256: "89d525ea5785fd8dcdcc3e925b91bb6e1484108a21153f2005daaf1a74ca8f2c",
  tuple: "node127-linux-x64-musl",
});
const expectedFaultArtifact = Object.freeze({
  bytes: 631_600,
  needed: Object.freeze(["libc.musl-x86_64.so.1"]),
  path: "fixtures/pty-runtime-faults/node127-linux-x64-musl/pty.node",
  sha256: "6e317833311cc8f77e7576dbdf2316de25239a4733d0fa4f02dd7d71be53e88c",
  tuple: "node127-linux-x64-musl-test-faults",
});
const runtimeReceiptKeys = Object.freeze([
  "argvEnvAuthority",
  "closeTerminal",
  "deadlineNoLaunch",
  "descriptorAuthority",
  "descriptorClosure",
  "drainTerminal",
  "eofByteWritten",
  "faultCleanup",
  "finalizerSafe",
  "geometry",
  "openRollback",
  "processTerminal",
  "residual",
  "termios",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const verifyRuntimeReceipt = (value) => {
  if (!exactKeys(value, runtimeReceiptKeys))
    throw new Error("PTY runtime proof receipt is not closed.");
  for (const key of runtimeReceiptKeys)
    if (value[key] !== true)
      throw new Error(`PTY runtime proof did not establish ${key}.`);
  return Object.freeze({ ...value });
};

const runtimeFixture = `import {fstatSync} from "node:fs";
let extraOpen=true;try{fstatSync(Number(process.env.EXTRA_FD));}catch{extraOpen=false;}
process.stdout.write(JSON.stringify({canonical:process.stdin.isRaw!==true,columns:process.stdout.columns,extraOpen,isTTY:process.stdin.isTTY===true&&process.stdout.isTTY===true,rows:process.stdout.rows})+"\\n");
process.stdin.resume();process.stdin.on("end",()=>process.exit(0));\n`;

const runtimeDriver = `import {createRequire} from "node:module";
import {closeSync,constants,fstatSync,openSync,readdirSync,readFileSync} from "node:fs";
if(process.versions.modules!=="127"||readFileSync("/etc/alpine-release","utf8").trim()!=="3.24.1")throw new Error("canonical runtime identity mismatch");
const require=createRequire(import.meta.url);const production=require(process.env.AGENTSCOPE_PTY_PRODUCTION);const faults=require(process.env.AGENTSCOPE_PTY_FAULTS);const fixture=process.env.AGENTSCOPE_PTY_FIXTURE;
const children=()=>readFileSync(\`/proc/self/task/\${process.pid}/children\`,"utf8").trim();const fds=()=>readdirSync("/proc/self/fd").length;const environment=extra=>[\`EXTRA_FD=\${extra}\`,"LANG=C","LC_ALL=C","PATH=/usr/local/bin:/usr/bin:/bin","TZ=UTC"];
const pair=()=>({interpreter:openSync("/usr/local/bin/node",constants.O_RDONLY|constants.O_NOFOLLOW),script:openSync(fixture,constants.O_RDONLY|constants.O_NOFOLLOW)});
const invoke=(addon,{args=[],env,milliseconds=2000}={})=>{const p=pair();const extra=openSync("/dev/null",constants.O_RDONLY|constants.O_NOFOLLOW);let terminal;try{return{extra,p,result:addon.fork(p.interpreter,p.script,args,env??environment(extra),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+BigInt(milliseconds)*1000000n,(code,signal)=>{terminal={code,signal};}),terminal:()=>terminal};}catch(error){for(const fd of [p.interpreter,p.script,extra])try{closeSync(fd);}catch{}throw error;}};
const rejects=(action,pattern)=>{let message="";try{action();}catch(error){message=String(error);}if(!pattern.test(message))throw new Error(\`rejection mismatch: \${message}\`);return message;};
const initialChildren=children();const initialFds=fds();rejects(()=>invoke(production,{milliseconds:-1}),/deadline is invalid or expired/);const deadlineNoLaunch=children()===initialChildren&&fds()===initialFds;
const wrong=openSync("/dev/null",constants.O_RDONLY|constants.O_NOFOLLOW);const valid=pair();rejects(()=>production.fork(wrong,valid.script,[],environment(-1),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+1000000000n,()=>{}),/authority is invalid/);rejects(()=>production.fork(valid.interpreter,wrong,[],environment(-1),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+1000000000n,()=>{}),/authority is invalid/);for(const fd of [wrong,valid.interpreter,valid.script])closeSync(fd);const descriptorAuthority=children()===initialChildren;
const hostile=(args,env)=>rejects(()=>invoke(production,{args,env}),/inventory|value is not a string|admission exceeded/);const sparse=[];sparse.length=0xffffffff;hostile([],sparse);hostile(sparse,[]);hostile(["bad\\0tail"],[]);hostile([], ["BAD=bad\\0tail"]);hostile([7],[]);const throwingArg=[];Object.defineProperty(throwingArg,0,{get(){throw new Error("argv getter rejected");}});throwingArg.length=1;rejects(()=>invoke(production,{args:throwingArg}),/argv getter rejected/);const throwingEnv=[];Object.defineProperty(throwingEnv,0,{get(){throw new Error("env getter rejected");}});throwingEnv.length=1;rejects(()=>invoke(production,{env:throwingEnv}),/env getter rejected/);const argvEnvAuthority=fds()===initialFds&&children()===initialChildren;
const faultResults=[];for(const bit of [1,2,3,4,7,8,9]){faults.testFault((1<<bit)|(bit===8?(1<<7):0));const before=children();const message=rejects(()=>invoke(faults,{milliseconds:bit===9?20:250}),/failed|invalid|expired|child joined/);faultResults.push(before===children()&&!message.includes("uncertain"));}for(const bit of [6,12]){faults.testFault((1<<bit)|(1<<7));const message=rejects(()=>invoke(faults,{milliseconds:80}),/cleanup uncertain/);faultResults.push(message.includes("uncertain"));}faults.testFault(0);const faultCleanup=faultResults.every(Boolean)&&children()===initialChildren;
const beforeOpen=fds();for(const bit of [10,11]){faults.testFault(1<<bit);rejects(()=>faults.open(80,24,process.hrtime.bigint()+1000000000n),/publication failed/);}const openRollback=fds()===beforeOpen;
const live=invoke(faults);for(const fd of [live.p.interpreter,live.p.script,live.extra])closeSync(fd);const first=faults.inspect(live.result.handle);faults.resize(live.result.handle,91,31,0,0);const resized=faults.inspect(live.result.handle);rejects(()=>faults.read(live.result.handle,0),/read bound/);rejects(()=>faults.write(live.result.handle,"not-bytes"),/Usage/);const write=faults.write(live.result.handle,Buffer.from("hello\\n"));const eof=faults.eof(live.result.handle);let output="";let observedTerminal=false;const end=Date.now()+2000;while(Date.now()<end){const observed=faults.read(live.result.handle,4096);if(observed.status==="data")output+=observed.bytes.toString();if((observed.status==="eof"||observed.status==="eio")&&live.terminal()){observedTerminal=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}faults.close(live.result.handle);rejects(()=>faults.inspect(live.result.handle),/identity changed/);
const parsed=JSON.parse(output.trim().split("\\n").find(line=>line.startsWith("{"))??"null");const descriptorClosure=parsed.extraOpen===false;const geometry=first.isTTY===true&&first.columns===80&&first.rows===24&&resized.columns===91&&resized.rows===31;const termios=first.canonical===true&&parsed.canonical===true&&Number.isInteger(first.eofByte);const eofByteWritten=eof.status==="eof-byte-written"&&eof.bytesWritten===1&&eof.eofByte===first.eofByte;const drainTerminal=write.status==="complete"&&output.includes("hello")&&observedTerminal;const processTerminal=live.terminal()?.code===0&&live.terminal()?.signal===0;
const closeLive=invoke(faults);for(const fd of [closeLive.p.interpreter,closeLive.p.script,closeLive.extra])closeSync(fd);faults.testFault(1<<5);const closeMessage=rejects(()=>faults.close(closeLive.result.handle),/close is uncertain/);rejects(()=>faults.inspect(closeLive.result.handle),/identity changed/);const reuse=openSync("/dev/null",constants.O_RDONLY);global.gc?.();await new Promise(resolve=>setTimeout(resolve,25));let reuseLive=true;try{fstatSync(reuse);}catch{reuseLive=false;}closeSync(reuse);const closeEnd=Date.now()+1000;while(Date.now()<closeEnd&&!closeLive.terminal())await new Promise(resolve=>setTimeout(resolve,10));const closeTerminal=closeMessage.includes("uncertain")&&closeLive.terminal()!==undefined;const finalizerSafe=reuseLive;
const happy=invoke(production);for(const fd of [happy.p.interpreter,happy.p.script,happy.extra])closeSync(fd);production.eof(happy.result.handle);const happyEnd=Date.now()+2000;while(Date.now()<happyEnd&&!happy.terminal()){production.read(happy.result.handle,4096);await new Promise(resolve=>setTimeout(resolve,10));}production.close(happy.result.handle);const residual=children()===initialChildren&&fds()===initialFds;
process.stdout.write(JSON.stringify({argvEnvAuthority,closeTerminal,deadlineNoLaunch,descriptorAuthority,descriptorClosure,drainTerminal,eofByteWritten,faultCleanup,finalizerSafe,geometry,openRollback,processTerminal,residual,termios}));\n`;

const readBoundedRegular = (
  path,
  maximumBytes = maximumArtifactBytes,
  expectedMode = 0o644,
) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size > maximumBytes ||
      (before.mode & 0o777) !== expectedMode
    )
      throw new Error(`PTY runtime input is not bounded regular data: ${path}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    )
      throw new Error(`PTY runtime input changed while reading: ${path}`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const exactKeys = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const virtualAddressToOffset = (address, loads) => {
  for (const segment of loads) {
    if (address >= segment.address && address < segment.address + segment.bytes)
      return segment.offset + (address - segment.address);
  }
  throw new Error("PTY runtime ELF string table is outside a load segment.");
};

// The closed ELF grammar is intentionally kept in one parser so every bound
// and rejected loader directive is evaluated against the same byte snapshot.
// eslint-disable-next-line complexity
const inspectElf = (bytes) => {
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes.subarray(1, 4).toString("ascii") !== "ELF" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== 62 ||
    bytes.readUInt32LE(20) !== 1
  )
    throw new Error("PTY runtime is not the selected ELF64 x86-64 object.");
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const programEntryBytes = bytes.readUInt16LE(54);
  const programEntries = bytes.readUInt16LE(56);
  if (
    programEntryBytes !== 56 ||
    programEntries < 1 ||
    programEntries > 128 ||
    programOffset + programEntryBytes * programEntries > bytes.length
  )
    throw new Error("PTY runtime ELF program headers are not bounded.");
  const loads = [];
  let dynamic;
  for (let index = 0; index < programEntries; index += 1) {
    const at = programOffset + index * programEntryBytes;
    const type = bytes.readUInt32LE(at);
    const segment = {
      address: Number(bytes.readBigUInt64LE(at + 16)),
      bytes: Number(bytes.readBigUInt64LE(at + 32)),
      offset: Number(bytes.readBigUInt64LE(at + 8)),
    };
    if (type === 1) loads.push(segment);
    if (type === 2) dynamic = segment;
  }
  if (
    dynamic === undefined ||
    dynamic.bytes > 64 * 1024 ||
    dynamic.offset + dynamic.bytes > bytes.length ||
    dynamic.bytes % 16 !== 0
  )
    throw new Error("PTY runtime ELF dynamic section is not bounded.");
  const neededOffsets = [];
  let stringAddress;
  let stringBytes;
  for (let at = dynamic.offset; at < dynamic.offset + dynamic.bytes; at += 16) {
    const tag = Number(bytes.readBigInt64LE(at));
    const value = Number(bytes.readBigUInt64LE(at + 8));
    if (tag === 0) break;
    if (tag === 1) neededOffsets.push(value);
    if (tag === 5) stringAddress = value;
    if (tag === 10) stringBytes = value;
    if (tag === 15 || tag === 22 || tag === 29)
      throw new Error("PTY runtime ELF contains a forbidden loader directive.");
  }
  if (
    stringAddress === undefined ||
    stringBytes === undefined ||
    stringBytes < 1 ||
    stringBytes > 128 * 1024
  )
    throw new Error("PTY runtime ELF string table is not bounded.");
  const stringOffset = virtualAddressToOffset(stringAddress, loads);
  if (stringOffset + stringBytes > bytes.length)
    throw new Error("PTY runtime ELF string table exceeds the file.");
  return neededOffsets.map((offset) => {
    if (offset < 0 || offset >= stringBytes)
      throw new Error("PTY runtime ELF dependency offset is invalid.");
    const start = stringOffset + offset;
    const end = bytes.indexOf(0, start);
    if (end < start || end >= stringOffset + stringBytes)
      throw new Error("PTY runtime ELF dependency is unterminated.");
    return bytes.subarray(start, end).toString("utf8");
  });
};

const verifyClosedSourceDirectory = (root, expected) => {
  const before = lstatSync(root);
  if (before.isSymbolicLink() || !before.isDirectory())
    throw new Error(`PTY source root is not a directory: ${root}`);
  const entries = readdirSync(root, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== [...expected].sort()[index])
  )
    throw new Error(`PTY source inventory is not exact: ${root}`);
};

const verifyFileIdentity = (path, bytes, digest, mode = 0o644) => {
  const contents = readBoundedRegular(path, maximumArtifactBytes, mode);
  if (contents.length !== bytes || sha256(contents) !== digest)
    throw new Error(`PTY source identity does not match authority: ${path}`);
};

export const verifySourceAuthority = (sourceRoot) => {
  const nodePtyRoot = resolve(sourceRoot, "third_party/node-pty");
  const addonApiRoot = resolve(sourceRoot, "third_party/node-addon-api");
  verifyClosedSourceDirectory(nodePtyRoot, [
    "LICENSE",
    "patches",
    "source-manifest.json",
    "src",
  ]);
  verifyClosedSourceDirectory(resolve(nodePtyRoot, "patches"), [
    "agentscope-terminal-authority.patch",
  ]);
  verifyClosedSourceDirectory(resolve(nodePtyRoot, "src"), ["unix"]);
  verifyClosedSourceDirectory(resolve(nodePtyRoot, "src/unix"), ["pty.cc"]);
  verifyClosedSourceDirectory(addonApiRoot, [
    "napi-inl.h",
    "napi.h",
    "source-manifest.json",
  ]);
  verifyFileIdentity(
    resolve(nodePtyRoot, "LICENSE"),
    3_326,
    "a3d60eaf32d2fb09c9d82ef39f14bd6e2c0f3ca7de30daa827486c0d6f8b6e9f",
  );
  verifyFileIdentity(
    resolve(nodePtyRoot, "src/unix/pty.cc"),
    23_090,
    "5809f87b15122f335017b0b3020071df4c6205c7827186a2c5a9e0edc9ef59b2",
  );
  verifyFileIdentity(
    resolve(nodePtyRoot, "patches/agentscope-terminal-authority.patch"),
    38_785,
    "77acf682848a7d2f66bf0c6c41a4ad3b78f32e328244797f6b56604be7b7f697",
  );
  verifyFileIdentity(
    resolve(nodePtyRoot, "source-manifest.json"),
    1_684,
    "ccfa7024fc94cc5d6469005e61c9a63640829f4d1af45d37950bd2727750bf61",
  );
  verifyFileIdentity(
    resolve(addonApiRoot, "napi.h"),
    115_423,
    "2f2f5d1e4ca96f315c51ad96c292c18294dbb999b98f8b2f33b80816a3189fb0",
  );
  verifyFileIdentity(
    resolve(addonApiRoot, "napi-inl.h"),
    219_411,
    "4b053c184dfed740fbd802fdcf97e85fb8c7b0eb1d83322000d932d31662eda7",
  );
  verifyFileIdentity(
    resolve(addonApiRoot, "source-manifest.json"),
    2_225,
    "aff0d41e4e5c77313d51cf6cfd070d43798520b4a8b7734b4acc600ded9e9b6e",
  );
  const nodePtyManifest = JSON.parse(
    readBoundedRegular(resolve(nodePtyRoot, "source-manifest.json"), 64 * 1024),
  );
  const addonApiManifest = JSON.parse(
    readBoundedRegular(
      resolve(addonApiRoot, "source-manifest.json"),
      64 * 1024,
    ),
  );
  if (
    nodePtyManifest.upstream?.commit !==
      "8f218f6c194be81d98b1eeea344b150e83445824" ||
    nodePtyManifest.upstream?.npmTarballSha256 !==
      "114ac80c3fe075eff76217a4122d135576582695f49c03a5da3835cdfc2f89c5" ||
    nodePtyManifest.agentscopePatch?.path !==
      "patches/agentscope-terminal-authority.patch" ||
    nodePtyManifest.agentscopePatch?.sha256 !==
      "77acf682848a7d2f66bf0c6c41a4ad3b78f32e328244797f6b56604be7b7f697" ||
    nodePtyManifest.agentscopePatch?.bytes !== 38_785 ||
    nodePtyManifest.agentscopePatch?.mode !== "0644" ||
    nodePtyManifest.agentscopePatch?.patchedSourceBytes !== 51_812 ||
    nodePtyManifest.agentscopePatch?.patchedSourceSha256 !==
      "e467e81bd4ac25a0eff52155bb11770e158e87a009d92bf2182b693a631e6eb8" ||
    addonApiManifest.upstream?.version !== "7.1.1" ||
    addonApiManifest.upstream?.tarballSha256 !==
      "b10455d15a977c0cd17a1cb0eb679e03d939f8ef8d4302eb33e1f78dacc71f82" ||
    addonApiManifest.license?.path !== "LICENSE.md" ||
    Buffer.byteLength(addonApiManifest.license?.text ?? "") !== 1_150 ||
    sha256(addonApiManifest.license?.text ?? "") !==
      "89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c"
  )
    throw new Error("PTY source provenance is not exact.");
};

// The closed policy conjunction is deliberately one fail-closed predicate.
// eslint-disable-next-line complexity
export const verifyPolicy = (root) => {
  verifyFileIdentity(
    resolve(root, "pty-runtime-policy.json"),
    8_833,
    "253a286316b7571c4f8ac89a7ebfaca8f419c200359dbd83f079cc3acf64c7b2",
  );
  const policy = JSON.parse(
    readBoundedRegular(resolve(root, "pty-runtime-policy.json"), 256 * 1024),
  );
  if (
    policy.target?.tuple !== expectedArtifact.tuple ||
    policy.target?.nodeVersion !== "22.23.2" ||
    policy.target?.nodeAbi !== 127 ||
    policy.alpineAuthority?.actualArchives !== 19 ||
    policy.alpineAuthority?.actualCompressedBytes !== 97_592_935 ||
    policy.build?.patch?.sha256 !==
      "77acf682848a7d2f66bf0c6c41a4ad3b78f32e328244797f6b56604be7b7f697" ||
    policy.build?.patch?.path !==
      "third_party/node-pty/patches/agentscope-terminal-authority.patch" ||
    policy.build?.patch?.bytes !== 38_785 ||
    policy.build?.patch?.patchedSourceBytes !== 51_812 ||
    policy.build?.patch?.patchedSourceSha256 !==
      "e467e81bd4ac25a0eff52155bb11770e158e87a009d92bf2182b693a631e6eb8" ||
    JSON.stringify(policy.build?.nativeExports) !==
      JSON.stringify([
        "close",
        "eof",
        "fork",
        "inspect",
        "open",
        "process",
        "read",
        "resize",
        "write",
      ]) ||
    !Array.isArray(policy.alpineAuthority?.packages) ||
    policy.alpineAuthority.packages.length !== 19
  )
    throw new Error("PTY runtime build policy is not exact.");
  return policy;
};

const verifyManifestAuthority = (authority, policy) => {
  if (
    !exactKeys(authority, [
      "buildArgumentsSha256",
      "buildEnvironmentSha256",
      "canonicalImageConfig",
      "canonicalImageIndex",
      "canonicalImageManifest",
      "nodeAddonApiSourceManifestSha256",
      "nodeHeaderInventorySha256",
      "nodePtySourceManifestSha256",
      "nativeExports",
      "packageClosureSha256",
      "patchSha256",
      "patchedSourceSha256",
      "policySha256",
      "signedIndexSha256",
      "signerKeySha256",
      "tuple",
    ]) ||
    authority.tuple !== expectedArtifact.tuple ||
    authority.canonicalImageIndex !== policy.canonicalImage.index ||
    authority.canonicalImageManifest !== policy.canonicalImage.manifest ||
    authority.canonicalImageConfig !== policy.canonicalImage.config ||
    authority.policySha256 !==
      "253a286316b7571c4f8ac89a7ebfaca8f419c200359dbd83f079cc3acf64c7b2" ||
    authority.packageClosureSha256 !==
      sha256(JSON.stringify(policy.alpineAuthority.packages)) ||
    authority.buildArgumentsSha256 !==
      sha256(JSON.stringify(policy.build.arguments)) ||
    authority.buildEnvironmentSha256 !==
      sha256(JSON.stringify(policy.build.environment)) ||
    authority.nodeHeaderInventorySha256 !==
      policy.canonicalImage.nodeHeaderInventorySha256 ||
    authority.signedIndexSha256 !== policy.alpineAuthority.index.sha256 ||
    authority.signerKeySha256 !==
      policy.alpineAuthority.index.signerKeySha256 ||
    authority.nodePtySourceManifestSha256 !==
      "ccfa7024fc94cc5d6469005e61c9a63640829f4d1af45d37950bd2727750bf61" ||
    authority.patchSha256 !== policy.build.patch.sha256 ||
    authority.patchedSourceSha256 !== policy.build.patch.patchedSourceSha256 ||
    JSON.stringify(authority.nativeExports) !==
      JSON.stringify(policy.build.nativeExports) ||
    authority.nodeAddonApiSourceManifestSha256 !==
      "aff0d41e4e5c77313d51cf6cfd070d43798520b4a8b7734b4acc600ded9e9b6e"
  )
    throw new Error("PTY runtime artifact authority is not exact.");
};

const verifyArtifactRecord = (record) => {
  if (
    !exactKeys(record, [
      "bytes",
      "format",
      "mode",
      "needed",
      "path",
      "reproducibility",
      "sha256",
      "tuple",
    ]) ||
    record.tuple !== expectedArtifact.tuple ||
    record.path !== expectedArtifact.path ||
    record.bytes !== expectedArtifact.bytes ||
    record.mode !== "0644" ||
    record.format !== "elf64-x86-64" ||
    record.sha256 !== expectedArtifact.sha256 ||
    !exactKeys(record.reproducibility, [
      "addonExecuted",
      "byteIdentical",
      "firstSha256",
      "independentCleanRoots",
      "secondSha256",
    ]) ||
    record.reproducibility.independentCleanRoots !== 2 ||
    record.reproducibility.firstSha256 !== expectedArtifact.sha256 ||
    record.reproducibility.secondSha256 !== expectedArtifact.sha256 ||
    record.reproducibility.byteIdentical !== true ||
    record.reproducibility.addonExecuted !== false ||
    JSON.stringify(record.needed) !== JSON.stringify(expectedArtifact.needed)
  )
    throw new Error("PTY runtime artifact record is not exact.");
};

const verifyFaultArtifactRecord = (record) => {
  if (
    !exactKeys(record, [
      "bytes",
      "format",
      "mode",
      "needed",
      "path",
      "sha256",
      "staged",
      "tuple",
    ]) ||
    record.tuple !== expectedFaultArtifact.tuple ||
    record.path !== expectedFaultArtifact.path ||
    record.bytes !== expectedFaultArtifact.bytes ||
    record.mode !== "0644" ||
    record.format !== "elf64-x86-64" ||
    record.sha256 !== expectedFaultArtifact.sha256 ||
    record.staged !== false ||
    JSON.stringify(record.needed) !==
      JSON.stringify(expectedFaultArtifact.needed)
  )
    throw new Error("PTY test-fault artifact record is not exact.");
};

// This is the one fail-closed conjunction for provenance, policy, artifact,
// ELF, and staging authority. Every subordinate check is mandatory.
export const verifyPtyRuntime = ({
  root = packageRoot,
  sourceRoot = repositoryRoot,
  stage = false,
} = {}) => {
  verifySourceAuthority(sourceRoot);
  const policy = verifyPolicy(root);
  verifyFileIdentity(
    resolve(root, "pty-runtime-artifacts.json"),
    2_675,
    "44f0c9f5fc6aed73062c54d2832ce707d3b4cebc2b7d160dbeb229ab85045c24",
  );
  const manifest = JSON.parse(
    readBoundedRegular(resolve(root, "pty-runtime-artifacts.json"), 64 * 1024),
  );
  if (
    !exactKeys(manifest, [
      "artifacts",
      "authority",
      "schemaVersion",
      "testArtifacts",
    ]) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 1 ||
    !Array.isArray(manifest.testArtifacts) ||
    manifest.testArtifacts.length !== 1
  )
    throw new Error("PTY runtime artifact manifest is not closed.");
  verifyManifestAuthority(manifest.authority, policy);
  const record = manifest.artifacts[0];
  verifyArtifactRecord(record);
  const faultRecord = manifest.testArtifacts[0];
  verifyFaultArtifactRecord(faultRecord);

  const source = resolve(root, record.path);
  const bytes = readBoundedRegular(source, maximumArtifactBytes, 0o644);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256)
    throw new Error("PTY runtime artifact bytes do not match authority.");
  if (
    bytes.includes(Buffer.from("AGENTSCOPE_PTY_TEST_FAULTS")) ||
    bytes.includes(Buffer.from("testFault"))
  )
    throw new Error("PTY runtime artifact contains test-fault authority.");
  const needed = inspectElf(bytes);
  if (JSON.stringify(needed) !== JSON.stringify(record.needed))
    throw new Error("PTY runtime dependency closure is not exact.");

  const faultSource = resolve(root, faultRecord.path);
  const faultBytes = readBoundedRegular(
    faultSource,
    maximumArtifactBytes,
    0o644,
  );
  if (
    faultBytes.length !== faultRecord.bytes ||
    sha256(faultBytes) !== faultRecord.sha256 ||
    !faultBytes.includes(Buffer.from("testFault"))
  )
    throw new Error("PTY test-fault artifact bytes do not match authority.");
  if (
    JSON.stringify(inspectElf(faultBytes)) !==
    JSON.stringify(faultRecord.needed)
  )
    throw new Error("PTY test-fault dependency closure is not exact.");
  verifyClosedSourceDirectory(resolve(root, "fixtures/pty-runtime-faults"), [
    "node127-linux-x64-musl",
  ]);
  verifyClosedSourceDirectory(resolve(root, dirname(faultRecord.path)), [
    "pty.node",
  ]);

  verifyClosedSourceDirectory(resolve(root, "pty-runtime"), [
    "node127-linux-x64-musl",
  ]);
  verifyClosedSourceDirectory(resolve(root, dirname(record.path)), [
    "pty.node",
  ]);

  if (stage) {
    const destination = resolve(root, "dist", record.path);
    mkdirSync(dirname(destination), { mode: 0o755, recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o644);
  }
  return Object.freeze({
    ...record,
    needed: Object.freeze([...record.needed]),
  });
};

// This is the inner, network-off receipt verifier. The explicit GitHub-hosted
// CI workflow owns the disposable-host Docker lifecycle and mounts the exact
// two authenticated artifacts read-only.
export const runPtyRuntimeProof = () => {
  verifyPtyRuntime();
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.versions.modules !== "127" ||
    readFileSync("/etc/alpine-release", "utf8").trim() !== "3.24.1"
  )
    throw new Error("PTY runtime proof requires the canonical inner runtime.");
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-pty-proof-"));
  chmodSync(root, 0o700);
  const fixture = resolve(root, "fixture.mjs");
  const driver = resolve(root, "driver.mjs");
  writeFileSync(fixture, runtimeFixture, { flag: "wx", mode: 0o400 });
  writeFileSync(driver, runtimeDriver, { flag: "wx", mode: 0o400 });
  const deadline = process.hrtime.bigint() + 30_000_000_000n;
  let primaryFailure;
  let cleanupFailure;
  try {
    const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
    if (remaining <= 0)
      throw new Error("PTY runtime proof exceeded its absolute deadline.");
    const output = execFileSync(
      "/usr/local/bin/node",
      ["--expose-gc", driver],
      {
        encoding: "utf8",
        env: {
          AGENTSCOPE_PTY_FAULTS: "/runtime/faults.node",
          AGENTSCOPE_PTY_FIXTURE: fixture,
          AGENTSCOPE_PTY_PRODUCTION: "/runtime/production.node",
          HOME: root,
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TZ: "UTC",
        },
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: remaining,
      },
    );
    if (process.hrtime.bigint() > deadline)
      throw new Error("PTY runtime proof exceeded its absolute deadline.");
    verifyRuntimeReceipt(JSON.parse(output.trim()));
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      rmSync(root, { force: true, recursive: true });
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (cleanupFailure !== undefined)
    throw new AggregateError(
      [primaryFailure, cleanupFailure].filter(Boolean),
      "PTY runtime proof cleanup is uncertain.",
      { cause: cleanupFailure },
    );
  if (primaryFailure !== undefined) throw primaryFailure;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length > 1 ||
    (arguments_.length === 1 &&
      arguments_[0] !== "--stage" &&
      arguments_[0] !== "--runtime-proof")
  )
    throw new Error("Usage: verify-pty-runtime.mjs [--stage|--runtime-proof]");
  if (arguments_[0] === "--runtime-proof") runPtyRuntimeProof();
  else verifyPtyRuntime({ stage: arguments_[0] === "--stage" });
}
