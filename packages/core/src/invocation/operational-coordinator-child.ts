/* v8 ignore file -- this module executes only as the separately verified built child. */
import { randomBytes } from "node:crypto";

import { createAgentscopeHomeFromOwnedRootForCore } from "../configuration/home.js";
import {
  createOperationalStateStore,
  inspectOperationalStateForHookForCore,
  recordHookOperationalEvidence,
  type HookOperationalEvidenceInput,
} from "../configuration/operational-state.js";
import { createConfigurationProcessIdentity } from "../configuration/transaction.js";

const MAXIMUM_REQUEST_BYTES = 524_288;
const PLATFORMS = new Set<NodeJS.Platform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

const fail = (): never => {
  process.exitCode = 1;
  throw new Error("core.operational-coordinator.invalid");
};

const isPlatform = (value: unknown): value is NodeJS.Platform =>
  typeof value === "string" && PLATFORMS.has(value as NodeJS.Platform);

const exactRequest = (
  value: unknown,
): Readonly<{
  kind: "preload" | "commit";
  homeRoot: string;
  platform: NodeJS.Platform;
  evidence?: HookOperationalEvidenceInput;
}> => {
  if (typeof value !== "object" || value === null) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((entry) => !("value" in entry))
  )
    return fail();
  const kind: unknown = descriptors.kind?.value;
  const homeRoot: unknown = descriptors.homeRoot?.value;
  const platform: unknown = descriptors.platform?.value;
  const keys = Object.keys(descriptors).sort().join("\0");
  if (
    (kind === "preload" && keys !== "homeRoot\0kind\0platform") ||
    (kind === "commit" && keys !== "evidence\0homeRoot\0kind\0platform") ||
    (kind !== "preload" && kind !== "commit") ||
    typeof homeRoot !== "string" ||
    homeRoot.length === 0 ||
    homeRoot.length > 4_096 ||
    !isPlatform(platform)
  )
    return fail();
  return Object.freeze({
    kind,
    homeRoot,
    platform,
    ...(kind === "commit"
      ? {
          evidence: descriptors.evidence!.value as HookOperationalEvidenceInput,
        }
      : {}),
  });
};

const main = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAXIMUM_REQUEST_BYTES) return fail();
    chunks.push(bytes);
  }
  const request = exactRequest(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
  );
  const home = createAgentscopeHomeFromOwnedRootForCore(
    request.homeRoot,
    request.platform,
  );
  const owner = createConfigurationProcessIdentity(
    process.pid,
    `process-start-v1-${randomBytes(32).toString("hex")}`,
  );
  const store = createOperationalStateStore(home, owner);
  const value =
    request.kind === "preload"
      ? await inspectOperationalStateForHookForCore(store)
      : await recordHookOperationalEvidence(store, request.evidence!);
  process.stdout.write(`${JSON.stringify({ kind: request.kind, value })}\n`);
};

void main().catch(() => {
  process.exitCode = 1;
});
