import { execFile } from "node:child_process";
import { parseAdmissionDocument } from "./admission.mjs";
import { inspectReleaseControlsWithGet } from "./release-controls.mjs";
import { sha256 } from "./validation.mjs";

const repository = "Melbourneandrew/agentscope";
const ownerId = 25971425;
const ownerLogin = "Melbourneandrew";
const bodyLimit = 1_048_576;
const headerLimit = 65_536;
const paths = new Set([
  "/rulesets?per_page=100",
  "/immutable-releases",
  "/branches/main/protection",
  "/environments/npm-release",
  "/environments/npm-release/deployment-branch-policies?per_page=100",
]);
const fail = () => {
  throw new Error("release.operator-controls.unresolved");
};

function responseBody(stdout, stderr) {
  if (
    !Buffer.isBuffer(stdout) ||
    !Buffer.isBuffer(stderr) ||
    stdout.length > bodyLimit + headerLimit ||
    stderr.length > headerLimit
  )
    fail();
  let offset = stdout.indexOf("\r\n\r\n");
  let separator = 4;
  if (offset < 0) {
    offset = stdout.indexOf("\n\n");
    separator = 2;
  }
  if (offset < 0 || offset > headerLimit) fail();
  const header = new TextDecoder("utf-8", { fatal: true })
    .decode(stdout.subarray(0, offset))
    .split(/\r?\n/u);
  if (!/^HTTP\/\d+(?:\.\d+)? 200(?: OK)?$/u.test(header.shift())) fail();
  for (const line of header) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+: .*$/u.test(line) ||
      [...line].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      /^link:/iu.test(line)
    )
      fail();
  }
  const body = Buffer.from(stdout.subarray(offset + separator));
  if (body.length < 1 || body.length > bodyLimit) fail();
  // Also reject malformed/truncated UTF-8 and JSON before retaining a digest.
  parseAdmissionDocument(body);
  return body;
}

// The existing operator's gh session supplies credentials internally. No token
// is extracted, passed as an argument, returned, or exported to the workflow.
// This is an operator attestation, not independent server proof or checkpoint
// authority. The existing checkpoint consumer owns tuple/phase/one-use binding.
export async function inspectOperatorReleaseControls({
  deadline,
  execFileImpl = execFile,
}) {
  try {
    if (!Number.isFinite(deadline) || typeof execFileImpl !== "function")
      fail();
    const responses = [];
    async function get(path) {
      if (
        path !== "/user" &&
        !paths.has(path) &&
        !/^\/rulesets\/[1-9][0-9]{0,15}$/u.test(path)
      )
        fail();
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) fail();
      const endpoint = path === "/user" ? "user" : `repos/${repository}${path}`;
      const body = await new Promise((resolve, reject) => {
        // execFile's callback settles after the child closes, including timeout
        // termination. Await that settlement; do not race and orphan a child.
        execFileImpl(
          "gh",
          [
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            "--include",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2026-03-10",
            "--",
            endpoint,
          ],
          {
            encoding: "buffer",
            maxBuffer: bodyLimit + headerLimit,
            timeout: remaining,
            killSignal: "SIGKILL",
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            try {
              if (error || performance.now() >= deadline) fail();
              resolve(responseBody(stdout, stderr));
            } catch {
              reject(new Error("release.operator-controls.unresolved"));
            }
          },
        );
      });
      responses.push(
        Object.freeze({ path, bytes: body.length, digest: sha256(body) }),
      );
      return body;
    }
    const owner = parseAdmissionDocument(await get("/user"));
    if (
      owner?.id !== ownerId ||
      owner.login !== ownerLogin ||
      owner.type !== "User"
    )
      fail();
    await inspectReleaseControlsWithGet({ get, deadline });
    if (performance.now() >= deadline) fail();
    return Object.freeze({
      state: "operator-controls-observed",
      repository,
      ownerId,
      ownerLogin,
      inspectedAt: new Date().toISOString(),
      responseCount: responses.length,
      responses: Object.freeze(responses),
    });
  } catch {
    // Never disclose gh stderr, settings response bodies, or credential errors.
    return fail();
  }
}
