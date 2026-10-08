import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { types } from "node:util";
import {
  projectNpmStageResponse,
  validateStageResult,
  validateStageTuple,
} from "./stage-result.mjs";

const outputLimit = 1_048_576;
const errorLimit = 65_536;
const fail = () => {
  throw new Error("release.npm-stage.unavailable");
};

// npm11.17.0 lib/commands/stage/publish.js delegates to Publish; its registry
// response supplies stageId and the standard --json package-keyed output.
// This utility is NOT an authorization mint, certification or one-use ledger.
// The protected composition must authenticate the same-run intent/checkpoint,
// verify and isolate immutable tarball bytes, and enforce expiry/CAS before use.
export async function produceNpmStage({
  tuple: input,
  tarballPath,
  deadline,
  execFileImpl = execFile,
}) {
  let tuple;
  try {
    tuple = validateStageTuple(input);
    if (
      typeof tarballPath !== "string" ||
      tarballPath.length > 4096 ||
      tarballPath.includes("\0") ||
      !isAbsolute(tarballPath) ||
      !tarballPath.endsWith(".tgz") ||
      !Number.isFinite(deadline) ||
      typeof execFileImpl !== "function"
    )
      fail();
  } catch {
    fail();
  }

  const ambiguous = () =>
    Object.freeze({
      schemaVersion: 1,
      tuple,
      response: "ambiguous",
      stageId: null,
    });
  async function run(args, limit) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) fail();
    return new Promise((resolve) => {
      try {
        execFileImpl(
          "npm",
          args,
          {
            encoding: "buffer",
            maxBuffer: Math.max(limit, errorLimit),
            timeout: Math.min(remaining, 2_147_483_647),
            killSignal: "SIGKILL",
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            try {
              if (
                error ||
                performance.now() >= deadline ||
                types.isProxy(stdout) ||
                types.isProxy(stderr) ||
                !Buffer.isBuffer(stdout) ||
                !Buffer.isBuffer(stderr) ||
                stdout.length > limit ||
                stderr.length > errorLimit
              )
                return resolve(null);
              // Snapshot before another callback can mutate synthetic buffers.
              resolve(Buffer.from(stdout));
            } catch {
              resolve(null);
            }
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  // Version acquisition and stage settlement share the original deadline.
  // Await the direct npm child callback/stdio closure; no race or detached
  // invocation. This trusted utility does not certify a hostile process set.
  // No token extraction, shell, arbitrary argv or retry path.
  const version = await run(["--version"], 128);
  if (!version || !/^11\.17\.0\r?\n?$/u.test(version.toString("utf8"))) fail();
  if (performance.now() >= deadline) fail();

  let result;
  try {
    const output = await run(
      [
        "stage",
        "publish",
        tarballPath,
        "--json",
        "--tag",
        tuple.distTag,
        "--provenance",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org",
      ],
      outputLimit,
    );
    result =
      output === null ? ambiguous() : projectNpmStageResponse(output, tuple);
  } catch {
    // After attempted invocation, uncertainty is retained, never a retry hint.
    result = ambiguous();
  }
  // Validate through the existing shared contract; return that original DTO,
  // not a new receipt shape or provenance/authentication claim.
  validateStageResult(result, tuple);
  return result;
}
