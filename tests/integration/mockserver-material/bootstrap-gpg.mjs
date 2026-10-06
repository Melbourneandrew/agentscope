/** Closed stock-GPG bootstrap verification inside the owned builder only. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";

const fail = () => {
  throw new Error("integration.mockserver-material.bootstrap-gpg");
};
const policies = Object.freeze({
  maven: Object.freeze({
    primary: "84789D24DF77A32433CE1F079EB80E92EB2135B1",
    hash: "10",
    signatureClass: "00",
  }),
  node: Object.freeze({
    primary: "C0D6248439F1D5604AAFFB4021D900FFDB233756",
    hash: "8",
    signatureClass: "01",
  }),
  jdk: Object.freeze({
    primary: "3B04D753C9050D9A5D343F39843C48A565F8F04B",
    hash: "10",
    signatureClass: "00",
  }),
});
const policyFor = (kind) => {
  if (typeof kind !== "string" || !Object.hasOwn(policies, kind)) fail();
  return policies[kind];
};
const objects = Object.freeze({
  maven: Object.freeze([
    [
      "key",
      279457,
      "1e53a10e6b65c64ae0f5a241c8ef289c7578f1109d8a78512dff7de2b29117b3",
    ],
    [
      "signature",
      902,
      "2787affc3cad25a8ef00d06002e2ff840aede80830debea018454bbacb17dc30",
    ],
    [
      "manifest",
      9395475,
      "5af3b743dd8b876b5c45da33b676251e5f1687712644abb4ee519ca56e1d89ce",
    ],
  ]),
  node: Object.freeze([
    [
      "key",
      3159,
      "4e615a57f63967ec40481be2fe6d57b39698257f31843ffe79af82d12a1806a2",
    ],
    [
      "signature",
      4659,
      "7be3cb73033671928c386b58e325e6ce724736a530910675cf300ba0bbc839c6",
    ],
    [
      "manifest",
      3777,
      "d67cdb735b1764bf5b553a0d9b067ed861b91a4d934afc20442c04f5234b55db",
    ],
  ]),
  jdk: Object.freeze([
    [
      "key",
      1793,
      "a46d5d3ab75c3c86dddf1bfd2957a067a24b1c6b2d2ed2bc69294bf970c5160b",
    ],
    [
      "signature",
      310,
      "6dee7b777982c477b1bbea4c729f3cac6404cece853ee924dc77e6b9daaa6154",
    ],
    [
      "manifest",
      193252603,
      "3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e",
    ],
  ]),
});
const authenticateObject = (
  [name, size, sha256],
  path = resolve("/verify", name),
) => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size !== size ||
      before.nlink !== 1 ||
      before.uid !== 0 ||
      before.gid !== 0 ||
      (before.mode & 0o7777) !== 0o600
    )
      fail();
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const length = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, size - offset),
        offset,
      );
      if (length < 1) fail();
      hash.update(chunk.subarray(0, length));
      offset += length;
    }
    const after = fstatSync(fd);
    if (
      hash.digest("hex") !== sha256 ||
      [
        "dev",
        "ino",
        "size",
        "mode",
        "uid",
        "gid",
        "nlink",
        "mtimeMs",
        "ctimeMs",
      ].some((field) => before[field] !== after[field])
    )
      fail();
  } finally {
    closeSync(fd);
  }
};
// A bounded read-only testing seam; never a signer or execution capability.
export const authenticateBootstrapGpgInputForTesting = (kind, name, path) => {
  policyFor(kind);
  if (typeof name !== "string" || typeof path !== "string") fail();
  const object = objects[kind].find((candidate) => candidate[0] === name);
  if (object === undefined) fail();
  authenticateObject(object, path);
};
const seconds = (value) => {
  if (!/^(?:0|[1-9]\d{0,10})$/u.test(value ?? "")) fail();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail();
  return number;
};

// GnuPG doc/DETAILS at 7eea4e5ff901f45830910fc3ccde009298ae5175.
// Category is diagnostic only; even informational records remain rejected.
const rejectedStatusCategory = (token) => {
  if (
    ["NOTATION_NAME", "NOTATION_FLAGS", "NOTATION_DATA", "POLICY_URL"].includes(
      token,
    )
  )
    return "information";
  if (
    [
      "BADSIG",
      "ERRSIG",
      "EXPSIG",
      "EXPKEYSIG",
      "REVKEYSIG",
      "NO_PUBKEY",
      "KEYEXPIRED",
      "KEYREVOKED",
      "SIGEXPIRED",
    ].includes(token)
  )
    return "rejection";
  return "unknown";
};

const verifyStatus = (kind, output, nowSeconds, enter) => {
  const policy = policyFor(kind);
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output) > 16_384 ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 1
  )
    fail();
  enter("signature-recordset", "signature-policy");
  const records = output
    .split("\n")
    .filter((line) => line.startsWith("[GNUPG:] "));
  const permitted = new Set([
    "NEWSIG",
    "KEY_CONSIDERED",
    "SIG_ID",
    "GOODSIG",
    "VALIDSIG",
    "TRUST_UNDEFINED",
    "TRUST_FULLY",
    "TRUST_ULTIMATE",
    "PLAINTEXT",
    "PLAINTEXT_LENGTH",
    "VERIFICATION_COMPLIANCE_MODE",
  ]);
  const rejected = records.find((line) => !permitted.has(line.split(" ")[1]));
  if (rejected !== undefined) {
    const category = rejectedStatusCategory(rejected.split(" ")[1]);
    try {
      enter(`signature-recordset-${category}`, "signature-policy");
    } catch {
      // Optional diagnostic failure cannot replace the original refusal.
    }
    fail();
  }
  enter("signature-count", "signature-policy");
  const valid = records.filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  const good = records.filter((line) => line.startsWith("[GNUPG:] GOODSIG "));
  if (valid.length !== 1 || good.length !== 1) fail();
  enter("signature-compliance", "signature-policy");
  // GnuPG emits this optional informational record after a valid signature.
  // It is not signer or cryptographic authority; the checks below still apply.
  const compliance = records.filter(
    (line) => line.split(" ")[1] === "VERIFICATION_COMPLIANCE_MODE",
  );
  if (
    compliance.length > 1 ||
    (compliance.length === 1 &&
      (compliance[0] !== "[GNUPG:] VERIFICATION_COMPLIANCE_MODE 23" ||
        records.indexOf(compliance[0]) < records.indexOf(valid[0])))
  )
    fail();
  enter("signature-signer", "signature-policy");
  const fields = valid[0].split(" ").slice(2);
  if (
    (fields.length !== 9 && fields.length !== 10) ||
    fields[0] !== policy.primary ||
    (fields[9] ?? fields[0]) !== policy.primary ||
    good[0].split(" ")[2] !== policy.primary.slice(-16)
  )
    fail();
  enter("signature-algorithm", "signature-policy");
  if (fields[4] !== "4" || fields[5] !== "0" || fields[6] !== "1") fail();
  enter("signature-hash", "signature-policy");
  if (fields[7] !== policy.hash) fail();
  enter("signature-class", "signature-policy");
  if (fields[8] !== policy.signatureClass) fail();
  enter("signature-time", "signature-policy");
  const created = seconds(fields[2]);
  const expiry = seconds(fields[3]);
  if (
    created < 1 ||
    created > nowSeconds ||
    (expiry !== 0 && expiry <= nowSeconds) ||
    fields[1] !== new Date(created * 1_000).toISOString().slice(0, 10)
  )
    fail();
  return Object.freeze({ primaryFingerprint: policy.primary, created, expiry });
};

// The public pure reader has no diagnostic sink or caller callback authority.
export const verifyBootstrapGpgStatus = (kind, output, nowSeconds) =>
  verifyStatus(kind, output, nowSeconds, () => undefined);

export const verifyBootstrapGpgListing = (kind, listing, nowSeconds) => {
  const policy = policyFor(kind);
  if (
    typeof listing !== "string" ||
    Buffer.byteLength(listing) > 16_384 ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 1
  )
    fail();
  const lines = listing
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(":"));
  const primary = lines.filter((line) => line[0] === "pub");
  const fingerprints = lines.filter((line) => line[0] === "fpr");
  const index = lines.findIndex((line) => line[0] === "pub");
  if (
    primary.length !== 1 ||
    fingerprints.length < 1 ||
    lines[index + 1]?.[0] !== "fpr" ||
    lines[index + 1]?.[9] !== policy.primary ||
    /[redi]/u.test(primary[0][1] ?? "") ||
    primary[0][4] !== policy.primary.slice(-16) ||
    !(primary[0][11] ?? "").includes("s")
  )
    fail();
  const created = seconds(primary[0][5]);
  const expiry = seconds(primary[0][6] || "0");
  if (
    created < 1 ||
    created > nowSeconds ||
    (expiry !== 0 && expiry <= nowSeconds)
  )
    fail();
  return Object.freeze({ created, expiry });
};

const argumentsFor = (home) => [
  "--batch",
  "--no-options",
  "--no-autostart",
  "--no-auto-key-retrieve",
  "--auto-key-locate",
  "clear",
  "--homedir",
  home,
];

// execute is the existing command's promisified execFile, not a new executor.
// The enclosing owned builder supplies the hard deadline and terminal boundary.
const runVerification = async (kind, execute, enter) => {
  const policy = policyFor(kind);
  enter("authenticate-inputs", "input");
  for (const object of objects[kind]) authenticateObject(object);
  const root = "/verify";
  const importedHome = resolve(root, "bootstrap-import");
  const selectedHome = resolve(root, "bootstrap-selected");
  enter("keyrings", "filesystem");
  mkdirSync(importedHome, { mode: 0o700 });
  mkdirSync(selectedHome, { mode: 0o700 });
  const environment = {
    HOME: selectedHome,
    LANG: "C.UTF-8",
    TZ: "UTC",
    PATH: "/usr/bin:/bin",
  };
  const invoke = (home, arguments_, encoding = "utf8") =>
    execute("/usr/bin/gpg", [...argumentsFor(home), ...arguments_], {
      cwd: root,
      env: environment,
      encoding,
      maxBuffer: 8 * 1024 * 1024,
    });
  enter("import-key", "gpg-execution");
  await invoke(importedHome, ["--import", resolve(root, "key")]);
  enter("export-key", "gpg-execution");
  const { stdout: selected } = await invoke(
    importedHome,
    ["--export", policy.primary],
    "buffer",
  );
  if (
    !Buffer.isBuffer(selected) ||
    selected.length < 1 ||
    selected.length > 1024 * 1024
  )
    fail();
  // Import only the exact selected primary, including its certifications and
  // revocations, into a second empty keyring. Maven KEYS may contain other keys.
  enter("selected-key-file", "filesystem");
  writeFileSync(resolve(root, "selected-key"), selected, {
    flag: "wx",
    mode: 0o600,
  });
  enter("import-selected", "gpg-execution");
  await invoke(selectedHome, ["--import", resolve(root, "selected-key")]);
  enter("list-key", "gpg-execution");
  const { stdout: listing } = await invoke(selectedHome, [
    "--with-colons",
    "--fingerprint",
    "--list-keys",
  ]);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  enter("listing-policy", "listing-policy");
  const key = verifyBootstrapGpgListing(kind, listing, nowSeconds);
  const cleartext = kind === "node";
  enter("verify-signature", "gpg-execution");
  const result = await invoke(
    selectedHome,
    cleartext
      ? ["--status-fd=2", "--decrypt", resolve(root, "signature")]
      : [
          "--status-fd=1",
          "--verify",
          resolve(root, "signature"),
          resolve(root, "manifest"),
        ],
  );
  enter("signature-policy", "signature-policy");
  const signature = verifyStatus(
    kind,
    cleartext ? result.stderr : result.stdout,
    nowSeconds,
    enter,
  );
  enter("signature-key-time", "signature-policy");
  if (
    signature.created < key.created ||
    (key.expiry !== 0 && signature.created >= key.expiry)
  )
    fail();
  if (cleartext) {
    enter("checksum-policy", "checksum-policy");
    const decoded = Buffer.from(result.stdout, "utf8");
    const expected = readFileSync(resolve(root, "manifest"));
    if (
      decoded.length !== 3777 ||
      expected.length !== 3777 ||
      !decoded.equals(expected) ||
      createHash("sha256").update(decoded).digest("hex") !==
        "d67cdb735b1764bf5b553a0d9b067ed861b91a4d934afc20442c04f5234b55db"
    )
      fail();
  }
};

/** Fixed observations only. A missing marker never changes verification. */
export const runBootstrapGpgVerification = async (kind, execute) => {
  let stage = "authenticate-inputs";
  let failureFamily = "input";
  const emit = (family) => {
    try {
      writeSync(
        2,
        `[agentscope-material:v1 stage=${stage} family=${family}]\n`,
      );
    } catch {
      // Optional diagnostic sink; preserve the original success or rejection.
    }
  };
  const enter = (next, family) => {
    stage = next;
    failureFamily = family;
    emit("none");
  };
  try {
    await runVerification(kind, execute, enter);
    stage = "completed";
    emit("none");
  } catch (error) {
    emit(failureFamily);
    throw error;
  }
};
