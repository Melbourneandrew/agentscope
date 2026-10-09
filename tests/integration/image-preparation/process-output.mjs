/** Pure output representation only; no subprocess or lifecycle authority. */
const maximumHeaderBytes = 16_384;
const supplierStages = [
  "supplier-connected-entry",
  "supplier-connected-extract",
  "supplier-connected-package",
  ...Array.from(
    { length: 12 },
    (_, index) =>
      `supplier-connected-package-goal-${String.fromCharCode(97 + index)}`,
  ),
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
  ...["maven", "npm"].flatMap((cache) => [
    `supplier-cache-${cache}`,
    ...["parent", "type", "owner", "device", "mode", "identity", "io"].map(
      (reason) => `supplier-cache-${cache}-${reason}`,
    ),
  ]),
  "supplier-extract",
  "supplier-package",
  ...Array.from(
    { length: 12 },
    (_, index) => `supplier-package-goal-${String.fromCharCode(97 + index)}`,
  ),
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
  /-(?:package-compilation|package-resolution|package-frontend|package-other|inventory-read|inventory-guard|inventory-internal|output-create|output-write|parent|type|owner|device|mode|identity|io)$/u.test(
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
const verifierMarkerBytes = Buffer.from("[agentscope-verifier");
const includesMarker = (suffix, segment, text, bytes) =>
  (suffix + segment.subarray(0, 256).toString("latin1")).includes(text) ||
  segment.includes(bytes);
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
        number < 0 || number > [256, 4, 12, 6, 999999, 999999, 21][index],
    )
  )
    return undefined;
  const [exit, signal, goal, unit, line, column, reason] = numbers;
  if (
    (unit === 0 && (line || column || reason)) ||
    (unit !== 0 &&
      (!line || !reason || (goal === 5 ? reason > 21 : !column || reason > 6)))
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
// BuildKit ExecOp wraps its RUN argv; this is its reported execution result,
// not the Docker client's close code or a Maven-child/OOM observation.
const createSupplierExecutionObservation = () => {
  let supplierExecution;
  let executionAmbiguous = false;
  return Object.freeze({
    observe(suffix, lineBytes) {
      if (!suffix.includes("did not complete successfully")) return;
      const match =
        /^(?:#\d{1,8} ERROR: |ERROR: failed to (?:build: failed to )?solve: )process "\/usr\/local\/bin\/node \/supplier\/command\/supplier-command\.mjs (dependency-research|offline-build|cache-seeding|service-offline)" did not complete successfully: exit code: (0|[1-9]\d{0,2})$/u.exec(
          suffix,
        );
      if (lineBytes > 256 || !match || Number(match[2]) > 255) {
        executionAmbiguous = true;
        return;
      }
      const next = Object.freeze({
        mode: match[1],
        exitCode: Number(match[2]),
      });
      if (
        supplierExecution &&
        (supplierExecution.mode !== next.mode ||
          supplierExecution.exitCode !== next.exitCode)
      )
        executionAmbiguous = true;
      supplierExecution = next;
    },
    snapshot(suffix) {
      if (suffix.includes("did not complete successfully"))
        executionAmbiguous = true;
      return !executionAmbiguous && supplierExecution
        ? { untrustedSupplierExecution: supplierExecution }
        : {};
    },
  });
};
const bootstrapObservation = (stage, family, mavenFailure, ambiguous) =>
  !ambiguous && stage !== "unknown"
    ? {
        untrustedBootstrapStage: stage,
        untrustedBootstrapFailureFamily: family,
        ...(mavenFailure === undefined
          ? {}
          : { untrustedMavenFailure: mavenFailure }),
      }
    : {};
const packageContext = (stage) =>
  /^(supplier-(?:connected-)?package)(?:-goal-[a-l])?$/u.exec(stage)?.[1];
// Plugin order and repetition are normal; a supported INFO entry is not an
// outcome. Finalization is likewise entered only after the package settles.
const validStageProgression = (previous, next, family) => {
  if (/-goal-[a-l]$/u.test(next))
    return (
      packageContext(previous) !== undefined &&
      packageContext(previous) === packageContext(next)
    );
  return (
    !supplierFailureStages.includes(previous) &&
    bootstrapStages.indexOf(next) >= bootstrapStages.indexOf(previous) &&
    (next !== previous || family !== "none")
  );
};
// Closed last-observed plain BuildKit role, never a completion/admission proof.
const createSupplierBuildPhaseObservation = () => {
  let worker;
  let vertex;
  let role;
  let stage;
  const copies = [
    ...["bin", "lib", "conf", "legal", "release", "NOTICE"].map((name) => [
      "java",
      `COPY --from=supplier /supplier/tools/jdk-17.0.20.1+1/${name} /opt/java/${name}`,
    ]),
    [
      "jar",
      "COPY --from=supplier --chmod=0444 /supplier/source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar /opt/mockserver.jar",
    ],
    [
      "control",
      "COPY --chmod=0600 control-private.pem control-jwks.json /opt/control/",
    ],
    [
      "configuration",
      "COPY --chmod=0444 expectations.json /config/expectations.json",
    ],
  ];
  return {
    marker(prefix, observed) {
      stage = undefined;
      worker = undefined;
      if (observed === "supplier-connected-service-finalization" && prefix)
        worker = prefix.trim();
    },
    line(text, bytes) {
      if (!worker || bytes > 256) return;
      const match = /^(#\d{1,8}) (.+)$/u.exec(text);
      if (!match) return;
      const [, id, body] = match;
      if (id === worker && /^DONE (?:0|[1-9]\d{0,5})\.\d{1,6}s$/u.test(body)) {
        stage = "supplier-image-worker-complete";
        return;
      }
      const copy = /^\[stage-1 [1-9]\d?\/[1-9]\d?\] (.+)$/u.exec(body);
      const selected = copies.find(([, command]) => command === copy?.[1]);
      if (selected) {
        vertex = id;
        role = `copy-${selected[0]}`;
        stage = `supplier-image-${role}`;
      } else if (
        id === vertex &&
        /^DONE (?:0|[1-9]\d{0,5})\.\d{1,6}s$/u.test(body)
      ) {
        stage = `supplier-image-${role}-complete`;
      } else {
        const exportRole =
          /^(exporting to docker image format|exporting layers|sending tarball|importing to docker)(?: (?:0|[1-9]\d{0,5})\.\d{1,6}s)?( done)?$/u.exec(
            body,
          );
        if (!exportRole) return;
        role = ["export", "layers", "tar", "load"][
          [
            "exporting to docker image format",
            "exporting layers",
            "sending tarball",
            "importing to docker",
          ].indexOf(exportRole[1])
        ];
        vertex = id;
        stage = `supplier-image-${role}${exportRole[2] ? "-complete" : ""}`;
      }
    },
    snapshot() {
      return stage;
    },
  };
};
const createVerifierFailureObservation = () => {
  let failure;
  let ambiguous = false;
  let candidate = false;
  return {
    consume(segment, suffix) {
      candidate ||=
        (suffix + segment.subarray(0, 256).toString("latin1")).includes(
          "[agentscope-verifier",
        ) || segment.includes(verifierMarkerBytes);
    },
    line(suffix, bytes) {
      if (!candidate) return false;
      candidate = false;
      const match =
        /^(?:(?:#\d{1,8} )?\d{1,8}\.\d{1,6} )?\[agentscope-verifier:v1 failure=(entry|npm-(?:input|version|install|lock|audit|bundles)|platform-(?:archive|inventory|member)|gpg-(?:home|import|list|key-policy|signature|signature-policy))\]$/u.exec(
          suffix,
        );
      if (bytes > 256 || !match || (failure && failure !== match[1]))
        ambiguous = true;
      else failure = match[1];
      return true;
    },
    snapshot() {
      return ambiguous || candidate
        ? "unknown"
        : failure
          ? `verifier-${failure}`
          : undefined;
    },
  };
};
const classifyBuildPrefix = (prefix, pending) =>
  classifyBuildxStderr(Buffer.concat([prefix, pending]).toString("utf8"));
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
  const verifier = createVerifierFailureObservation();
  const execution = createSupplierExecutionObservation();
  const buildPhase = createSupplierBuildPhaseObservation();
  const originalLines = new Set();
  const replayedLines = new Set();
  const line = () => {
    if (verifier.line(suffix, lineBytes)) return true;
    execution.observe(suffix, lineBytes);
    buildPhase.line(suffix, lineBytes);
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
      !validStageProgression(stage, match[3], match[4])
    ) {
      ambiguous = true;
      return true;
    }
    stage = match[3];
    buildPhase.marker(match[1], stage);
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
        candidate ||= includesMarker(suffix, segment, marker, markerBytes);
        verifier.consume(segment, suffix);
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
      return Object.freeze({
        stderrClass:
          verifier.snapshot() ??
          classifyBuildPrefix(
            prefix.subarray(0, prefixBytes),
            pending.subarray(0, pendingBytes),
          ),
        ...bootstrapObservation(
          buildPhase.snapshot() ?? stage,
          buildPhase.snapshot() ? "none" : family,
          mavenFailure,
          ambiguous,
        ),
        ...execution.snapshot(suffix),
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
