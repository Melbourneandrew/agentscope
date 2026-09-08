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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const maximumArtifactBytes = 2 * 1024 * 1024;
const expectedArtifact = Object.freeze({
  bytes: 647_840,
  needed: Object.freeze(["libc.musl-x86_64.so.1"]),
  path: "pty-runtime/node127-linux-x64-musl/pty.node",
  sha256: "00c2d70427923ec598dd105a78d5eb099e7ad52accfa98ef65cc9f2195c3a8ff",
  tuple: "node127-linux-x64-musl",
});
const expectedFaultArtifact = Object.freeze({
  bytes: 648_176,
  needed: Object.freeze(["libc.musl-x86_64.so.1"]),
  path: "fixtures/pty-runtime-faults/node127-linux-x64-musl/pty.node",
  sha256: "7a5468057ae55ba587e66ccef1858e59586a05039019c88d4bd196650a47faaa",
  tuple: "node127-linux-x64-musl-test-faults",
});
const runtimeReceiptKeys = Object.freeze([
  "adoptedZombieReap",
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
  "reapPidOneOnly",
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
import {isatty} from "node:tty";
if(process.versions.modules!=="127"||readFileSync("/etc/alpine-release","utf8").trim()!=="3.24.1")throw new Error("canonical runtime identity mismatch");
const require=createRequire(import.meta.url);const production=require(process.env.AGENTSCOPE_PTY_PRODUCTION);const faults=require(process.env.AGENTSCOPE_PTY_FAULTS);const fixture=process.env.AGENTSCOPE_PTY_FIXTURE;
const pidOneChildren=()=>readFileSync("/proc/1/task/1/children","utf8").trim();const children=()=>readFileSync(\`/proc/\${process.pid}/task/\${process.pid}/children\`,"utf8").trim();const fdInventory=()=>{const entries=readdirSync("/proc/self/fd");if(entries.length>256||entries.some(entry=>!/^(0|[1-9][0-9]{0,5})$/.test(entry)))throw new Error("descriptor inventory is not bounded");return entries.map(Number);};const fds=()=>fdInventory().length;const terminalFds=()=>fdInventory().filter(fd=>isatty(fd));const environment=extra=>[\`EXTRA_FD=\${extra}\`,"LANG=C","LC_ALL=C","PATH=/usr/local/bin:/usr/bin:/bin","TZ=UTC"];
const pair=()=>({interpreter:openSync("/usr/local/bin/node",constants.O_RDONLY|constants.O_NOFOLLOW),script:openSync(fixture,constants.O_RDONLY|constants.O_NOFOLLOW)});
const invoke=(addon,{args=[],env,milliseconds=2000}={})=>{const p=pair();const extra=openSync("/dev/null",constants.O_RDONLY|constants.O_NOFOLLOW);let terminal;try{return{extra,p,result:addon.fork(p.interpreter,p.script,args,env??environment(extra),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+BigInt(milliseconds)*1000000n,(code,signal)=>{terminal={code,signal};}),terminal:()=>terminal};}catch(error){for(const fd of [p.interpreter,p.script,extra])try{closeSync(fd);}catch{}throw error;}};
const rejects=(action,pattern)=>{let message="";try{action();}catch(error){message=String(error);}if(!pattern.test(message))throw new Error(\`rejection mismatch: \${message}\`);return message;};
const initialPidOneChildren=pidOneChildren();if(initialPidOneChildren!==String(process.pid))throw new Error("runtime PID namespace containment is not exact");const initialChildren=children();const initialFds=fds();rejects(()=>invoke(production,{milliseconds:-1}),/deadline is invalid or expired/);const deadlineNoLaunch=pidOneChildren()===initialPidOneChildren&&children()===initialChildren&&fds()===initialFds;
const reapPidOneOnly=/authority is invalid/.test(rejects(()=>production.reapAdoptedZombie(2,"2:1",3,process.hrtime.bigint()+1000000000n),/authority is invalid/));
const wrong=openSync("/dev/null",constants.O_RDONLY|constants.O_NOFOLLOW);const valid=pair();rejects(()=>production.fork(wrong,valid.script,[],environment(-1),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+1000000000n,()=>{}),/authority is invalid/);rejects(()=>production.fork(valid.interpreter,wrong,[],environment(-1),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+1000000000n,()=>{}),/authority is invalid/);rejects(()=>production.fork(valid.interpreter,valid.interpreter,[],environment(-1),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+1000000000n,()=>{}),/authority is invalid/);const reused=valid.script;closeSync(valid.script);const replacement=openSync("/dev/null",constants.O_RDONLY|constants.O_NOFOLLOW);if(replacement!==reused)throw new Error("descriptor reuse setup failed");rejects(()=>production.fork(valid.interpreter,replacement,[],environment(-1),"/",80,24,-1,-1,true,"",process.hrtime.bigint()+1000000000n,()=>{}),/authority is invalid/);faults.testFault(1<<13);rejects(()=>invoke(faults),/authority is invalid/);faults.testFault(0);for(const fd of [wrong,valid.interpreter,replacement])closeSync(fd);const descriptorAuthority=children()===initialChildren;
const hostile=(args,env)=>rejects(()=>invoke(production,{args,env}),/inventory|value is not a string|admission exceeded/);const sparse=[];sparse.length=0xffffffff;hostile([],sparse);hostile(sparse,[]);hostile(["bad\\0tail"],[]);hostile([], ["BAD=bad\\0tail"]);hostile([7],[]);const throwingArg=[];Object.defineProperty(throwingArg,0,{get(){throw new Error("argv getter rejected");}});throwingArg.length=1;rejects(()=>invoke(production,{args:throwingArg}),/argv getter rejected/);const throwingEnv=[];Object.defineProperty(throwingEnv,0,{get(){throw new Error("env getter rejected");}});throwingEnv.length=1;rejects(()=>invoke(production,{env:throwingEnv}),/env getter rejected/);const argvEnvAuthority=fds()===initialFds&&children()===initialChildren;
const faultResults=[];for(const bit of [1,2,3,4,7,8,9]){faults.testFault((1<<bit)|(bit===8?(1<<7):0));const before=children();const message=rejects(()=>invoke(faults,{milliseconds:bit===9?20:250}),/failed|invalid|expired|child joined/);faultResults.push(before===children()&&!message.includes("uncertain"));}for(const bit of [6,12]){faults.testFault((1<<bit)|(1<<7));const message=rejects(()=>invoke(faults,{milliseconds:80}),/cleanup uncertain/);faultResults.push(message.includes("uncertain"));}faults.testFault(0);const faultCleanup=faultResults.every(Boolean)&&children()===initialChildren;
const beforeOpen=fds();for(const bit of [10,11]){faults.testFault(1<<bit);rejects(()=>faults.open(80,24,process.hrtime.bigint()+1000000000n),/publication failed/);}const openRollback=fds()===beforeOpen;
const live=invoke(faults);for(const fd of [live.p.interpreter,live.p.script,live.extra])closeSync(fd);const first=faults.inspect(live.result.handle);faults.resize(live.result.handle,91,31,0,0);const resized=faults.inspect(live.result.handle);rejects(()=>faults.read(live.result.handle,0),/read bound/);rejects(()=>faults.write(live.result.handle,"not-bytes"),/Usage/);const write=faults.write(live.result.handle,Buffer.from("hello\\n"));const eof=faults.eof(live.result.handle);let output="";let observedTerminal=false;const end=Date.now()+2000;while(Date.now()<end){const observed=faults.read(live.result.handle,4096);if(observed.status==="data")output+=observed.bytes.toString();if((observed.status==="eof"||observed.status==="eio")&&live.terminal()){observedTerminal=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}faults.close(live.result.handle);rejects(()=>faults.inspect(live.result.handle),/identity changed/);
const parsed=JSON.parse(output.trim().split("\\n").find(line=>line.startsWith("{"))??"null");const descriptorClosure=parsed.extraOpen===false;const geometry=first.isTTY===true&&first.columns===80&&first.rows===24&&resized.columns===91&&resized.rows===31&&parsed.isTTY===true&&parsed.columns===91&&parsed.rows===31;const termios=first.canonical===true&&parsed.canonical===true&&Number.isInteger(first.eofByte);const eofByteWritten=eof.status==="eof-byte-written"&&eof.bytesWritten===1&&eof.eofByte===first.eofByte;const drainTerminal=write.status==="complete"&&write.bytesWritten===6&&output.includes("hello\\r\\n")&&observedTerminal&&live.terminal()!==undefined;const processTerminal=live.terminal()?.code===0&&live.terminal()?.signal===0;
const closeFinalizerToken=Symbol("agentscope-pty-close-finalizer");let closeFinalizerState="pending";let closeFinalizerCount=0;let closeFinalizerDropped=false;const closeRegistry=new FinalizationRegistry(value=>{closeFinalizerCount+=1;closeFinalizerState=closeFinalizerDropped&&value===closeFinalizerToken&&closeFinalizerCount===1?"exact":"invalid";});const terminalBeforeClose=new Set(terminalFds());let closeLive=invoke(faults);for(const fd of [closeLive.p.interpreter,closeLive.p.script,closeLive.extra])closeSync(fd);const ownedTerminalFds=terminalFds().filter(fd=>!terminalBeforeClose.has(fd));if(ownedTerminalFds.length!==1)throw new Error("owned PTY descriptor inventory is not exact");const detachedPtyFd=ownedTerminalFds[0];if(detachedPtyFd<3||detachedPtyFd>255)throw new Error("detached PTY descriptor exceeds the reuse bound");faults.testFault(1<<5);const closeMessage=rejects(()=>faults.close(closeLive.result.handle),/close is uncertain/);rejects(()=>faults.inspect(closeLive.result.handle),/identity changed/);closeRegistry.register(closeLive.result.handle,closeFinalizerToken);const closeTerminalReceipt=closeLive.terminal;closeLive.result.handle=undefined;closeLive.result=undefined;closeLive=null;closeFinalizerDropped=true;const reuseFds=[];const reuseSet=new Set();for(let count=0;count<64&&reuseFds.at(-1)!==detachedPtyFd;count+=1){const candidate=openSync("/dev/null",constants.O_RDONLY);if(reuseSet.has(candidate))throw new Error("descriptor reuse filler was duplicated");if(candidate>detachedPtyFd)throw new Error("exact detached PTY descriptor reuse was skipped");reuseSet.add(candidate);reuseFds.push(candidate);}const reuse=reuseFds.at(-1);if(reuse!==detachedPtyFd)throw new Error("exact detached PTY descriptor was not reused");const reuseIdentity=fstatSync(reuse);const closeEnd=Date.now()+1000;while(Date.now()<closeEnd&&(closeFinalizerState==="pending"||closeTerminalReceipt()===undefined)){global.gc?.();await new Promise(resolve=>setTimeout(resolve,10));}let reuseLive=true;try{const after=fstatSync(reuse);reuseLive=after.dev===reuseIdentity.dev&&after.ino===reuseIdentity.ino&&after.mode===reuseIdentity.mode;}catch{reuseLive=false;}for(const fd of reuseFds.reverse())closeSync(fd);const closeTerminal=closeMessage.includes("uncertain")&&closeFinalizerState==="exact"&&closeFinalizerCount===1&&reuseLive&&closeTerminalReceipt()!==undefined;
const finalizerToken=Symbol("agentscope-pty-finalizer");let finalizerState="pending";let finalizerCount=0;let finalizerDropped=false;const registry=new FinalizationRegistry(value=>{finalizerCount+=1;finalizerState=finalizerDropped&&value===finalizerToken&&finalizerCount===1?"exact":"invalid";});let abandoned=invoke(faults);for(const fd of [abandoned.p.interpreter,abandoned.p.script,abandoned.extra])closeSync(fd);const abandonedTerminal=abandoned.terminal;registry.register(abandoned.result.handle,finalizerToken);if(finalizerState!=="pending"||finalizerCount!==0)throw new Error("finalizer receipt arrived before authority release");abandoned.result.handle=undefined;abandoned.result=undefined;abandoned=null;finalizerDropped=true;const finalizerEnd=Date.now()+1000;while(Date.now()<finalizerEnd&&(finalizerState==="pending"||abandonedTerminal()===undefined)){global.gc?.();await new Promise(resolve=>setTimeout(resolve,10));}const finalizerSafe=reuseLive&&finalizerState==="exact"&&finalizerCount===1&&abandonedTerminal()!==undefined;
const semanticFaults=[];for(const [bit,method,argument,pattern] of [[14,"inspect",undefined,/inspection failed/],[16,"write",Buffer.from("x"),/write failed/],[17,"eof",undefined,/EOF mode/]]){const opened=faults.open(80,24,process.hrtime.bigint()+1000000000n);faults.testFault(1<<bit);const action=()=>argument===undefined?faults[method](opened.master):faults[method](opened.master,argument);semanticFaults.push(pattern.test(rejects(action,pattern)));faults.testFault(0);faults.close(opened.slave);faults.close(opened.master);}const readFault=faults.open(80,24,process.hrtime.bigint()+1000000000n);faults.testFault(1<<15);const readFaultReceipt=faults.read(readFault.master,16);const readFaultDescriptor=Object.getOwnPropertyDescriptor(readFaultReceipt,"status");semanticFaults.push(Object.getPrototypeOf(readFaultReceipt)===Object.prototype&&Object.keys(readFaultReceipt).length===1&&Object.hasOwn(readFaultReceipt,"status")&&!Object.hasOwn(readFaultReceipt,"bytes")&&!("bytes" in readFaultReceipt)&&readFaultDescriptor!==undefined&&Object.hasOwn(readFaultDescriptor,"value")&&readFaultDescriptor.value==="eio"&&readFaultDescriptor.get===undefined&&readFaultDescriptor.set===undefined);faults.testFault(0);faults.close(readFault.slave);faults.close(readFault.master);if(!semanticFaults.every(Boolean))throw new Error("semantic fault matrix failed");
const happy=invoke(production);for(const fd of [happy.p.interpreter,happy.p.script,happy.extra])closeSync(fd);production.eof(happy.result.handle);const happyEnd=Date.now()+2000;while(Date.now()<happyEnd&&!happy.terminal()){production.read(happy.result.handle,4096);await new Promise(resolve=>setTimeout(resolve,10));}production.close(happy.result.handle);const residual=pidOneChildren()===initialPidOneChildren&&children()===initialChildren&&fds()===initialFds;
process.stdout.write(JSON.stringify({argvEnvAuthority,closeTerminal,deadlineNoLaunch,descriptorAuthority,descriptorClosure,drainTerminal,eofByteWritten,faultCleanup,finalizerSafe,geometry,openRollback,processTerminal,reapPidOneOnly,residual,termios}));\n`;

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
    47_812,
    "64bc27e6cca43197a8537acd12b6406a80390c5144bde228690c267a9245fcf9",
  );
  verifyFileIdentity(
    resolve(nodePtyRoot, "source-manifest.json"),
    1_719,
    "faa566edd6ed7be7de77ab1fc9e921e6b53c0109baa90ac85a96317bae2953f4",
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
      "64bc27e6cca43197a8537acd12b6406a80390c5144bde228690c267a9245fcf9" ||
    nodePtyManifest.agentscopePatch?.bytes !== 47_812 ||
    nodePtyManifest.agentscopePatch?.mode !== "0644" ||
    nodePtyManifest.agentscopePatch?.patchedSourceBytes !== 60_514 ||
    nodePtyManifest.agentscopePatch?.patchedSourceSha256 !==
      "7b1400517bb83a9b9888828b0a9b75966d53436f2fda1027e2d9a06239223d0b" ||
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
    8_860,
    "7887af4db8a33cbbb7dcb1480765a67791501794d8764197901359163cf9f09d",
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
      "64bc27e6cca43197a8537acd12b6406a80390c5144bde228690c267a9245fcf9" ||
    policy.build?.patch?.path !==
      "third_party/node-pty/patches/agentscope-terminal-authority.patch" ||
    policy.build?.patch?.bytes !== 47_812 ||
    policy.build?.patch?.patchedSourceBytes !== 60_514 ||
    policy.build?.patch?.patchedSourceSha256 !==
      "7b1400517bb83a9b9888828b0a9b75966d53436f2fda1027e2d9a06239223d0b" ||
    JSON.stringify(policy.build?.nativeExports) !==
      JSON.stringify([
        "close",
        "eof",
        "fork",
        "inspect",
        "open",
        "process",
        "read",
        "reapAdoptedZombie",
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
      "7887af4db8a33cbbb7dcb1480765a67791501794d8764197901359163cf9f09d" ||
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
      "faa566edd6ed7be7de77ab1fc9e921e6b53c0109baa90ac85a96317bae2953f4" ||
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
    2_702,
    "d7ab6f5c9227143ea43574a4f8d2122c087190a8164a7a8d69f690688613421d",
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
    bytes.includes(Buffer.from("testFault")) ||
    !bytes.includes(Buffer.from("reapAdoptedZombie"))
  )
    throw new Error("PTY runtime artifact export authority is not exact.");
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
    sha256(faultBytes) !== faultRecord.sha256
  )
    throw new Error("PTY test-fault artifact bytes do not match authority.");
  if (
    !faultBytes.includes(Buffer.from("testFault")) ||
    !faultBytes.includes(Buffer.from("reapAdoptedZombie"))
  )
    throw new Error("PTY test-fault artifact exports do not match authority.");
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

const sleepSynchronous = (milliseconds) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

export const parseProcessStatIdentity = (pid, bytes) => {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 2 ||
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > 4_096
  )
    throw new Error("PTY adopted process identity is not bounded.");
  const record = bytes.toString("utf8");
  const commandEnd = record.lastIndexOf(")");
  if (
    commandEnd < 0 ||
    record[commandEnd + 1] !== " " ||
    commandEnd + 2 >= record.length
  )
    throw new Error("PTY adopted process identity is malformed.");
  const fields = record
    .slice(commandEnd + 2)
    .trim()
    .split(" ");
  if (
    fields.length < 20 ||
    !/^[A-Z]$/u.test(fields[0]) ||
    !/^[1-9][0-9]*$/u.test(fields[1]) ||
    !/^[1-9][0-9]*$/u.test(fields[19])
  )
    throw new Error("PTY adopted process identity is malformed.");
  return Object.freeze({
    parent: Number(fields[1]),
    startIdentity: `${pid}:${fields[19]}`,
    state: fields[0],
  });
};

const readProcessIdentity = (pid) =>
  parseProcessStatIdentity(pid, readFileSync(`/proc/${pid}/stat`));

const exactReapReceipt = (value, pid, startIdentity, status) =>
  exactKeys(value, ["pid", "startIdentity", "status"]) &&
  value.pid === pid &&
  value.startIdentity === startIdentity &&
  value.status === status;

// The bounded runtime matrix deliberately keeps admission, mutation, and
// terminal reconciliation in one authority scope.
// eslint-disable-next-line max-lines-per-function, complexity
const proveAdoptedZombieReap = (deadline) => {
  if (process.pid !== 1)
    throw new Error("PTY adopted-zombie proof requires PID 1.");
  const require = createRequire(import.meta.url);
  const production = require("/runtime/production.node");
  const faults = require("/runtime/faults.node");
  let rootPid;
  const targets = [];
  const reaped = new Set();
  try {
    const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
    if (remaining <= 0)
      throw new Error("PTY adopted-zombie proof exceeded its deadline.");
    const launch = spawnSync(
      "/bin/sh",
      [
        "-c",
        '/bin/sleep 30 </dev/null >/dev/null 2>/dev/null & first=$!; /bin/sleep 30 </dev/null >/dev/null 2>/dev/null & second=$!; printf \'%s,%s\' "$first" "$second"',
      ],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TZ: "UTC" },
        maxBuffer: 64,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: remaining,
      },
    );
    if (
      launch.error !== undefined ||
      launch.status !== 0 ||
      launch.signal !== null ||
      launch.stderr !== "" ||
      !/^[1-9][0-9]{0,9},[1-9][0-9]{0,9}$/u.test(launch.stdout) ||
      !Number.isSafeInteger(launch.pid)
    )
      throw new Error("PTY adopted process fixture did not launch exactly.");
    rootPid = launch.pid;
    for (const encodedPid of launch.stdout.split(",")) {
      const pid = Number(encodedPid);
      const identity = readProcessIdentity(pid);
      if (
        !Number.isSafeInteger(pid) ||
        pid < 2 ||
        identity.parent !== 1 ||
        identity.state === "Z"
      )
        throw new Error("PTY adopted process fixture identity is not exact.");
      targets.push(
        Object.freeze({ pid, startIdentity: identity.startIdentity }),
      );
    }
    if (targets.length !== 2 || targets[0].pid === targets[1].pid)
      throw new Error("PTY adopted process fixture inventory is not exact.");
    const [first, second] = targets;
    let rejectedRoot = false;
    try {
      production.reapAdoptedZombie(
        first.pid,
        first.startIdentity,
        first.pid,
        deadline,
      );
    } catch (error) {
      rejectedRoot = /authority is invalid/u.test(String(error));
    }
    const malformedAuthorities = [
      () =>
        production.reapAdoptedZombie(0, first.startIdentity, rootPid, deadline),
      () =>
        production.reapAdoptedZombie(
          first.pid + 0.5,
          first.startIdentity,
          rootPid,
          deadline,
        ),
      () => production.reapAdoptedZombie(first.pid, "", rootPid, deadline),
      () =>
        production.reapAdoptedZombie(
          String(first.pid),
          first.startIdentity,
          rootPid,
          deadline,
        ),
    ];
    let rejectedMalformed = true;
    for (const action of malformedAuthorities) {
      try {
        action();
        rejectedMalformed = false;
      } catch (error) {
        rejectedMalformed &&= /authority is invalid|Usage:/u.test(
          String(error),
        );
      }
    }
    let rejectedIdentity = false;
    try {
      production.reapAdoptedZombie(
        first.pid,
        `${first.pid}:${BigInt(first.startIdentity.split(":")[1]) + 1n}`,
        rootPid,
        deadline,
      );
    } catch (error) {
      rejectedIdentity = /identity changed/u.test(String(error));
    }
    let admittedIdentityBoundary = false;
    try {
      production.reapAdoptedZombie(
        first.pid,
        "1".repeat(64),
        rootPid,
        deadline,
      );
    } catch (error) {
      admittedIdentityBoundary = /identity changed/u.test(String(error));
    }
    let rejectedOversizeIdentity = true;
    for (const identity of ["1".repeat(65), "1".repeat(65_536)]) {
      try {
        production.reapAdoptedZombie(first.pid, identity, rootPid, deadline);
        rejectedOversizeIdentity = false;
      } catch (error) {
        rejectedOversizeIdentity &&= /authority is invalid/u.test(
          String(error),
        );
      }
    }
    faults.testFault(1 << 20);
    let rejectedParent = false;
    try {
      faults.reapAdoptedZombie(
        second.pid,
        second.startIdentity,
        rootPid,
        deadline,
      );
    } catch (error) {
      rejectedParent = /identity changed/u.test(String(error));
    } finally {
      faults.testFault(0);
    }
    const notReady = production.reapAdoptedZombie(
      first.pid,
      first.startIdentity,
      rootPid,
      deadline,
    );
    if (
      !rejectedRoot ||
      !rejectedMalformed ||
      !rejectedIdentity ||
      !admittedIdentityBoundary ||
      !rejectedOversizeIdentity ||
      !rejectedParent ||
      !exactReapReceipt(notReady, first.pid, first.startIdentity, "not-ready")
    )
      throw new Error("PTY adopted process admission proof failed.");
    for (const target of targets) {
      process.kill(target.pid, "SIGKILL");
      while (process.hrtime.bigint() < deadline) {
        const observed = readProcessIdentity(target.pid);
        if (
          observed.parent !== 1 ||
          observed.startIdentity !== target.startIdentity
        )
          throw new Error("PTY adopted process identity changed before reap.");
        if (observed.state === "Z") break;
        sleepSynchronous(10);
      }
      if (readProcessIdentity(target.pid).state !== "Z")
        throw new Error("PTY adopted process did not become a zombie.");
    }
    let rejectedDeadline = false;
    try {
      production.reapAdoptedZombie(
        first.pid,
        first.startIdentity,
        rootPid,
        process.hrtime.bigint() - 1n,
      );
    } catch (error) {
      rejectedDeadline = /authority is invalid/u.test(String(error));
    }
    faults.testFault((1 << 19) | (1 << 21));
    let rejectedInterruptedDrift = false;
    try {
      faults.reapAdoptedZombie(
        first.pid,
        first.startIdentity,
        rootPid,
        deadline,
      );
    } catch (error) {
      rejectedInterruptedDrift = /identity changed/u.test(String(error));
    } finally {
      faults.testFault(0);
    }
    if (!rejectedDeadline || !rejectedInterruptedDrift)
      throw new Error("PTY adopted process deadline or drift was admitted.");
    faults.testFault(1 << 19);
    const interruptedReceipt = faults.reapAdoptedZombie(
      first.pid,
      first.startIdentity,
      rootPid,
      deadline,
    );
    faults.testFault(0);
    if (
      !exactReapReceipt(
        interruptedReceipt,
        first.pid,
        first.startIdentity,
        "reaped",
      )
    )
      throw new Error("PTY interrupted adopted process reap was not exact.");
    reaped.add(first.pid);
    faults.testFault(1 << 18);
    let rejectedEchild = false;
    try {
      faults.reapAdoptedZombie(
        second.pid,
        second.startIdentity,
        rootPid,
        deadline,
      );
    } catch (error) {
      rejectedEchild = /reap persisted/u.test(String(error));
    } finally {
      faults.testFault(0);
    }
    faults.testFault((1 << 18) | (1 << 23));
    let rejectedEchildReuse = false;
    try {
      faults.reapAdoptedZombie(
        second.pid,
        second.startIdentity,
        rootPid,
        deadline,
      );
    } catch (error) {
      rejectedEchildReuse = /identity changed/u.test(String(error));
    } finally {
      faults.testFault(0);
    }
    faults.testFault((1 << 18) | (1 << 22));
    const alreadyAbsent = faults.reapAdoptedZombie(
      second.pid,
      second.startIdentity,
      rootPid,
      deadline,
    );
    faults.testFault(0);
    if (
      !rejectedEchild ||
      !rejectedEchildReuse ||
      !exactReapReceipt(
        alreadyAbsent,
        second.pid,
        second.startIdentity,
        "already-absent",
      )
    )
      throw new Error("PTY adopted process ambiguity was admitted.");
    const receipt = production.reapAdoptedZombie(
      second.pid,
      second.startIdentity,
      rootPid,
      deadline,
    );
    if (!exactReapReceipt(receipt, second.pid, second.startIdentity, "reaped"))
      throw new Error("PTY adopted process reap receipt is not exact.");
    reaped.add(second.pid);
    for (const target of targets) {
      try {
        readProcessIdentity(target.pid);
        throw new Error("PTY adopted process remains after reap.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return true;
  } finally {
    faults.testFault(0);
    for (const target of targets) {
      if (reaped.has(target.pid)) continue;
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
        // The subsequent authenticated reap remains the terminal authority.
      }
      try {
        production.reapAdoptedZombie(
          target.pid,
          target.startIdentity,
          rootPid,
          deadline,
        );
      } catch {
        // A failed best-effort reap cannot turn the proof into success.
      }
    }
  }
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
    const driverReceipt = JSON.parse(output.trim());
    const adoptedZombieReap = proveAdoptedZombieReap(deadline);
    verifyRuntimeReceipt({ ...driverReceipt, adoptedZombieReap });
    process.stdout.write('{"version":1,"status":"passed"}\n');
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
