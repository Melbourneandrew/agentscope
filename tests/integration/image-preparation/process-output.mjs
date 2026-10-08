/** Pure output representation only; no subprocess or lifecycle authority. */
const maximumHeaderBytes = 16_384;
const supplierStages = [
  "supplier-connected-entry",
  "supplier-connected-extract",
  "supplier-connected-package",
  "supplier-connected-package-compilation",
  "supplier-connected-package-resolution",
  "supplier-connected-package-frontend",
  "supplier-connected-package-other",
  "supplier-connected-service-finalization",
  "supplier-connected-inventory",
  "supplier-connected-inventory-read",
  "supplier-connected-inventory-guard",
  "supplier-connected-inventory-internal",
  "supplier-connected-output-create",
  "supplier-connected-output-write",
  "supplier-entry",
  "supplier-extract",
  "supplier-package",
  "supplier-package-compilation",
  "supplier-package-resolution",
  "supplier-package-frontend",
  "supplier-package-other",
  "supplier-service-finalization",
  "supplier-inventory",
  "supplier-inventory-read",
  "supplier-inventory-guard",
  "supplier-inventory-internal",
  "supplier-output-create",
  "supplier-output-write",
];
const supplierFailureStages = supplierStages.filter((stage) =>
  /-(?:package-compilation|package-resolution|package-frontend|package-other|service-finalization|inventory-read|inventory-guard|inventory-internal|output-create|output-write)$/u.test(
    stage,
  ),
);
const bootstrapStages = [
  "authenticate-inputs",
  "keyrings",
  "import-key",
  "export-key",
  "selected-key-file",
  "import-selected",
  "list-key",
  "listing-policy",
  "verify-signature",
  "signature-policy",
  "signature-recordset",
  "signature-recordset-information",
  "signature-recordset-rejection",
  "signature-recordset-unknown",
  "signature-count",
  "signature-compliance",
  "signature-signer",
  "signature-algorithm",
  "signature-hash",
  "signature-class",
  "signature-time",
  "signature-key-time",
  "checksum-policy",
  "completed",
  ...supplierStages,
];
const bootstrapFamilies = [
  "none",
  "input",
  "filesystem",
  "gpg-execution",
  "listing-policy",
  "signature-policy",
  "checksum-policy",
];
const marker = "[agentscope-material";
const markerBytes = Buffer.from(marker);
const familyFor = (stage) =>
  stage === "authenticate-inputs"
    ? "input"
    : ["keyrings", "selected-key-file"].includes(stage)
      ? "filesystem"
      : stage.startsWith("signature-")
        ? "signature-policy"
        : ["listing-policy", "signature-policy", "checksum-policy"].includes(
              stage,
            )
          ? stage
          : stage === "completed"
            ? "none"
            : "gpg-execution";

/** Closed, untrusted package observation; never executable/output content. */
export const parseMavenFailureObservation = (value) => {
  if (typeof value !== "string" || value.length > 96) return undefined;
  const fields = value.split(",");
  if (
    fields.length !== 8 ||
    !["absent", "overflow", "ambiguous", "unlisted", "identified"].includes(
      fields[0],
    )
  )
    return undefined;
  const numbers = fields
    .slice(1)
    .map((field) =>
      /^(?:0|[1-9][0-9]{0,5})$/u.test(field) ? Number(field) : -1,
    );
  if (
    numbers.some(
      (number, index) =>
        number < 0 || number > [256, 4, 12, 6, 999999, 999999, 6][index],
    )
  )
    return undefined;
  const [exit, signal, goal, unit, line, column, reason] = numbers;
  if (
    (unit === 0 && (line || column || reason)) ||
    (unit !== 0 && (!line || !column || !reason))
  )
    return undefined;
  if (
    fields[0] === "identified"
      ? !goal && !unit
      : fields[0] === "ambiguous"
        ? unit
        : goal || unit
  )
    return undefined;
  return Object.freeze({
    disposition: fields[0],
    exitCode: exit === 0 ? null : exit - 1,
    signal:
      signal === 0
        ? null
        : ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"][signal - 1],
    goal,
    unit,
    line,
    column,
    reason,
  });
};

/** Untrusted text observation only; neither markers nor absence grant authority. */
const validMavenMarker = (stage, family, tuple) =>
  tuple === undefined ||
  (/^supplier-(?:connected-)?package-(?:compilation|resolution|frontend|other)$/u.test(
    stage,
  ) &&
    family === "none" &&
    parseMavenFailureObservation(tuple) !== undefined);
export const createBuildStderrObservation = () => {
  const prefix = Buffer.alloc(maximumHeaderBytes);
  const pending = Buffer.alloc(maximumHeaderBytes);
  let prefixBytes = 0;
  let pendingBytes = 0;
  let rawBytes = 0;
  let suffix = "";
  let lineBytes = 0;
  let candidate = false;
  let ambiguous = false;
  let stage = "unknown";
  let family = "unknown";
  let mavenFailure;
  const originalLines = new Set();
  const replayedLines = new Set();
  const line = () => {
    if (!candidate) return false;
    const match =
      /^(?:(#\d{1,8} )?(\d{1,8}\.\d{1,6}) )?\[agentscope-material:v1 stage=([a-z-]+) family=([a-z-]+)(?: maven=([a-z0-9,]+))?\]$/u.exec(
        suffix,
      );
    if (
      lineBytes > 256 ||
      !match ||
      !bootstrapStages.includes(match[3]) ||
      !bootstrapFamilies.includes(match[4]) ||
      (supplierStages.includes(match[3]) && match[4] !== "none") ||
      (match[4] !== "none" && match[4] !== familyFor(match[3])) ||
      !validMavenMarker(match[3], match[4], match[5])
    ) {
      ambiguous = true;
      return false;
    }
    const identity = `${match[2]} ${match[3]} ${match[4]} ${match[5] ?? ""}`;
    // Plain BuildKit repeats failed-vertex logs without their #vertex prefix.
    // Only an exact previously observed timestamp/enum tuple is a replay;
    // it cannot advance the observation or introduce another marker value.
    if (match[2] !== undefined && match[1] === undefined) {
      if (!originalLines.has(identity) || replayedLines.has(identity))
        ambiguous = true;
      else replayedLines.add(identity);
      return true;
    }
    if (
      (family !== "unknown" && family !== "none") ||
      supplierFailureStages.includes(stage) ||
      bootstrapStages.indexOf(match[3]) < bootstrapStages.indexOf(stage) ||
      (match[3] === stage && match[4] === "none")
    ) {
      ambiguous = true;
      return true;
    }
    stage = match[3];
    family = match[4];
    mavenFailure = parseMavenFailureObservation(match[5]);
    if (match[1] !== undefined) originalLines.add(identity);
    return true;
  };
  return Object.freeze({
    consume(chunk) {
      rawBytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        const pendingSegment = chunk.subarray(
          offset,
          newline === -1 ? end : end + 1,
        );
        pendingBytes += pendingSegment.copy(
          pending,
          pendingBytes,
          0,
          Math.max(0, maximumHeaderBytes - prefixBytes - pendingBytes),
        );
        candidate ||=
          (suffix + segment.subarray(0, 256).toString("latin1")).includes(
            marker,
          ) || segment.includes(markerBytes);
        suffix =
          segment.length >= 256
            ? segment.subarray(-256).toString("latin1")
            : (suffix + segment.toString("latin1")).slice(-256);
        lineBytes += segment.length;
        if (newline !== -1) {
          // Fixed neutral marker lines do not displace the legacy classifier's
          // first16KiB of non-marker text or introduce a classifier keyword.
          if (!line()) {
            pending.copy(prefix, prefixBytes, 0, pendingBytes);
            prefixBytes += pendingBytes;
          }
          pendingBytes = 0;
          suffix = "";
          lineBytes = 0;
          candidate = false;
        }
        offset = newline === -1 ? chunk.length : newline + 1;
      }
      return rawBytes > maximumHeaderBytes;
    },
    snapshot() {
      if (candidate) ambiguous = true;
      const observation =
        !ambiguous && stage !== "unknown"
          ? {
              untrustedBootstrapStage: stage,
              untrustedBootstrapFailureFamily: family,
              ...(mavenFailure === undefined
                ? {}
                : { untrustedMavenFailure: mavenFailure }),
            }
          : {};
      return Object.freeze({
        stderrClass: classifyBuildxStderr(
          Buffer.concat([
            prefix.subarray(0, prefixBytes),
            pending.subarray(0, pendingBytes),
          ]).toString("utf8"),
        ),
        ...observation,
      });
    },
  });
};
const buildxStderrClassifiers = Object.freeze([
  ["resource-conflict", /(?:already exists|existing instance)/iu],
  ["build-failed", /(?:failed to solve|failed to build)/iu],
  [
    "bootstrap-failed",
    /(?:failed to boot|bootstrap|connection refused|unavailable)/iu,
  ],
  ["permission-denied", /(?:permission denied|operation not permitted)/iu],
]);
export const classifyBuildxStderr = (value) => {
  if (typeof value !== "string" || value.length > maximumHeaderBytes)
    return "unknown";
  return (
    buildxStderrClassifiers.find(([, pattern]) => pattern.test(value))?.[0] ??
    "unknown"
  );
};
export const selectCommandOutput = (value) => {
  if (value === undefined) return "text";
  if (value !== "text" && value !== "binary")
    throw new Error("integration.images.build.input");
  return value;
};
export const serializeCommandOutput = (chunks, selection) => {
  const bytes = Buffer.concat(chunks);
  return selection === "binary" ? bytes : bytes.toString("utf8");
};
