import { sha256 } from "./validation.mjs";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types } from "node:util";
import { parseAdmissionDocument } from "./admission.mjs";

const repository = "/repos/Melbourneandrew/agentscope";
const fail = () => {
  throw new Error("release.store.unresolved");
};

// One absolute deadline includes response bodies and readback. No redirect,
// overwrite, delete or retry is permitted after an uncertain mutation.
function createRequest({ token, deadline, fetchImpl }) {
  if (typeof token !== "string" || !token || !Number.isFinite(deadline)) fail();
  return async function request(
    method,
    path,
    body,
    upload = false,
    binary = false,
  ) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetchImpl(
        `${upload ? "https://uploads.github.com" : "https://api.github.com"}${repository}${path}`,
        {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: binary
              ? "application/octet-stream"
              : "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": upload
              ? "application/octet-stream"
              : "application/json",
          },
          ...(body === undefined
            ? {}
            : { body: upload ? body : JSON.stringify(body) }),
        },
      );
      if (!response.ok) fail();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (
          size > (binary ? 52_428_800 : 2_097_152) ||
          performance.now() >= deadline
        ) {
          controller.abort();
          fail();
        }
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      return binary ? bytes : JSON.parse(bytes.toString("utf8"));
    } catch {
      fail();
    } finally {
      clearTimeout(timer);
    }
  };
}

function id(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
}

// Ancestry only; enforcement is inspected by the existing fresh operator
// controls checkpoint. This read does not mint probe or publishing authority.
async function assertMainAncestry(request, sourceRevision) {
  if (
    typeof sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(sourceRevision)
  )
    fail();
  const comparison = await request("GET", `/compare/${sourceRevision}...main`);
  if (
    !["ahead", "identical"].includes(comparison.status) ||
    comparison.merge_base_commit?.sha !== sourceRevision
  )
    fail();
}

function mainCommit(ref) {
  if (
    ref?.ref !== "refs/heads/main" ||
    ref.object?.type !== "commit" ||
    !/^[a-f0-9]{40}$/u.test(ref.object.sha)
  )
    fail();
  return ref.object.sha;
}

async function completeTree(request, sha) {
  if (!/^[a-f0-9]{40}$/u.test(sha)) fail();
  const value = await request("GET", `/git/trees/${sha}`);
  if (
    value?.sha !== sha ||
    value.truncated !== false ||
    !Array.isArray(value.tree) ||
    value.tree.length > 10_000
  )
    fail();
  const names = new Set();
  for (const entry of value.tree) {
    if (
      typeof entry?.path !== "string" ||
      entry.path.length < 1 ||
      entry.path.length > 255 ||
      /[\\/]/u.test(entry.path) ||
      [...entry.path].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || code === 127;
      }) ||
      [".", ".."].includes(entry.path) ||
      names.has(entry.path) ||
      !/^[a-f0-9]{40}$/u.test(entry.sha) ||
      ![
        "tree:040000",
        "blob:100644",
        "blob:100755",
        "blob:120000",
        "commit:160000",
      ].includes(`${entry.type}:${entry.mode}`)
    )
      fail();
    names.add(entry.path);
  }
  return value.tree;
}

async function assertNoBootstrapTransaction(request) {
  // Current protected-main contents, never a caller's absent/terminal label or
  // the older candidate checkout. No bootstrap terminal grammar exists yet;
  // every present record remains unaccounted and refuses ordinary authority.
  const sourceRevision = mainCommit(
    await request("GET", "/git/ref/heads/main"),
  );
  const commit = await request("GET", `/git/commits/${sourceRevision}`);
  if (commit?.sha !== sourceRevision) fail();
  let entries = await completeTree(request, commit.tree?.sha);
  for (const path of ["release-records", "bootstrap"]) {
    const entry = entries.find((value) => value.path === path);
    if (entry === undefined) {
      entries = [];
      break;
    }
    if (entry.type !== "tree" || entry.mode !== "040000") fail();
    entries = await completeTree(request, entry.sha);
  }
  if (
    entries.length !== 0 ||
    mainCommit(await request("GET", "/git/ref/heads/main")) !== sourceRevision
  )
    fail();
}

function createGhRunner(token, deadline, execFileImpl) {
  return async function runGh(args, authenticated = false) {
    const root = mkdtempSync(join(tmpdir(), "agentscope-release-attestation-"));
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) fail();
      return await new Promise((resolve, reject) => {
        execFileImpl(
          "gh",
          args,
          {
            encoding: "buffer",
            maxBuffer: 2_097_152,
            timeout: remaining,
            killSignal: "SIGKILL",
            windowsHide: true,
            env: {
              PATH: process.env.PATH,
              LANG: "C",
              HOME: root,
              GH_CONFIG_DIR: root,
              GH_HOST: "github.com",
              ...(authenticated ? { GH_TOKEN: token } : {}),
            },
          },
          (error, stdout) => {
            if (
              error ||
              types.isProxy(stdout) ||
              !Buffer.isBuffer(stdout) ||
              stdout.length > 2_097_152 ||
              performance.now() >= deadline
            )
              reject(new Error("release.store.unresolved"));
            else resolve(Buffer.from(stdout));
          },
        );
      });
    } catch {
      fail();
    } finally {
      rmSync(root, { recursive: true, force: false });
    }
  };
}

async function verifyAttestationCapability(runGh) {
  const version = (await runGh(["--version"])).toString("utf8");
  const match = /^gh version (\d+)\.(\d+)\.(\d+) /u.exec(version);
  // v2.83.2 primary source supplies this standard verified JSON contract.
  // Older clients can return ordinary release help with exit0 for an
  // unknown subcommand, so help exit alone is not capability evidence.
  if (
    !match ||
    Number(match[1]) < 2 ||
    (Number(match[1]) === 2 &&
      (Number(match[2]) < 83 ||
        (Number(match[2]) === 83 && Number(match[3]) < 2)))
  )
    fail();
  const help = (await runGh(["release", "verify", "--help"])).toString("utf8");
  if (
    !help.includes(
      "Verify that a GitHub Release is accompanied by a valid cryptographically signed attestation.",
    ) ||
    !help.includes("--format")
  )
    fail();
  return sha256(Buffer.from(version));
}

async function publishDraft(request, releaseId) {
  const before = await request("GET", `/releases/${id(releaseId)}`);
  if (
    before.id !== releaseId ||
    before.draft !== true ||
    before.immutable === true ||
    before.prerelease !== true ||
    before.tag_name !== "v0.1.0"
  )
    fail();
  let uncertain = false;
  try {
    await request("PATCH", `/releases/${id(releaseId)}`, { draft: false });
  } catch {
    uncertain = true;
  }
  // Missing mutation response is not permission to repeat PATCH.
  const after = await request("GET", `/releases/${id(releaseId)}`);
  if (
    after.id !== releaseId ||
    after.prerelease !== true ||
    after.tag_name !== before.tag_name
  )
    fail();
  return Object.freeze({ release: after, uncertain });
}

function snapshotAttestationAssets(expectedAssets) {
  const expected = [];
  for (let index = 0; index < expectedAssets.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(
      expectedAssets,
      String(index),
    );
    if (!entry || !Object.hasOwn(entry, "value")) fail();
    const asset = entry.value;
    if (!asset || types.isProxy(asset)) fail();
    const name = Object.getOwnPropertyDescriptor(asset, "name");
    const digest = Object.getOwnPropertyDescriptor(asset, "digest");
    if (
      !name ||
      !Object.hasOwn(name, "value") ||
      !digest ||
      !Object.hasOwn(digest, "value") ||
      typeof name.value !== "string" ||
      !/^[a-z0-9.-]{1,120}$/u.test(name.value) ||
      typeof digest.value !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(digest.value)
    )
      fail();
    expected.push({ name: name.value, digest: digest.value });
  }
  if (new Set(expected.map((asset) => asset.name)).size !== expected.length)
    fail();
  return expected;
}

async function verifyImmutableAttestation(
  runGh,
  releaseId,
  expectedAssets,
  tagObjectSha,
) {
  // Standard gh release verify performs cryptographic GitHub trust-domain
  // verification; local JSON/digest equality alone is not an attestation.
  if (
    !Number.isSafeInteger(releaseId) ||
    releaseId < 1 ||
    types.isProxy(expectedAssets) ||
    !Array.isArray(expectedAssets) ||
    expectedAssets.length > 100 ||
    !/^[a-f0-9]{40}$/u.test(tagObjectSha)
  )
    fail();
  const expected = snapshotAttestationAssets(expectedAssets);
  try {
    const bytes = await runGh(
      [
        "release",
        "verify",
        "v0.1.0",
        "--repo",
        "Melbourneandrew/agentscope",
        "--format",
        "json",
      ],
      true,
    );
    const result = parseAdmissionDocument(bytes);
    const envelope = result.attestation?.bundle?.dsseEnvelope;
    if (
      !result.verificationResult ||
      typeof envelope?.payload !== "string" ||
      envelope.payloadType !== "application/vnd.in-toto+json"
    )
      fail();
    const statement = parseAdmissionDocument(
      Buffer.from(envelope.payload, "base64"),
    );
    const predicate = statement.predicate;
    if (
      statement.predicateType !==
        "https://in-toto.io/attestation/release/v0.1" ||
      predicate?.ownerId !== "25971425" ||
      predicate.releaseId !== String(releaseId) ||
      predicate.repository !== "Melbourneandrew/agentscope" ||
      predicate.tag !== "v0.1.0" ||
      predicate.purl !== "pkg:github/Melbourneandrew/agentscope@v0.1.0" ||
      !Array.isArray(statement.subject) ||
      statement.subject.length !== expected.length + 1
    )
      fail();
    const releaseSubjects = statement.subject.filter(
      (subject) =>
        subject.uri === predicate.purl && subject.digest?.sha1 === tagObjectSha,
    );
    if (
      releaseSubjects.length !== 1 ||
      expected.some(
        (asset) =>
          statement.subject.filter(
            (subject) =>
              subject.name === asset.name &&
              subject.digest?.sha256 === asset.digest.slice(7),
          ).length !== 1,
      )
    )
      fail();
    return sha256(bytes);
  } catch {
    fail();
  }
}

export function createGitHubReleaseStore({
  token,
  deadline,
  fetchImpl = fetch,
  execFileImpl = execFile,
}) {
  const request = createRequest({ token, deadline, fetchImpl });
  const runGh = createGhRunner(token, deadline, execFileImpl);
  async function assets(releaseId) {
    const value = await request(
      "GET",
      `/releases/${id(releaseId)}/assets?per_page=100`,
    );
    if (!Array.isArray(value) || value.length >= 100) fail();
    return value;
  }
  return Object.freeze({
    run: (runId) => request("GET", `/actions/runs/${id(runId)}`),
    approvals: (runId) =>
      request("GET", `/actions/runs/${id(runId)}/approvals`),
    protectedMainSource: (sourceRevision) =>
      assertMainAncestry(request, sourceRevision),
    assertNoBootstrapTransaction: () => assertNoBootstrapTransaction(request),
    async protectedSource(sourceRevision) {
      if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) fail();
      const ref = await request("GET", "/git/ref/tags/v0.1.0");
      if (ref.object?.type !== "tag" || !/^[a-f0-9]{40}$/u.test(ref.object.sha))
        fail();
      const tag = await request("GET", `/git/tags/${ref.object.sha}`);
      if (
        tag.tag !== "v0.1.0" ||
        tag.object?.type !== "commit" ||
        tag.object.sha !== sourceRevision
      )
        fail();
      await assertMainAncestry(request, sourceRevision);
      return Object.freeze({ sourceRevision, tagObjectSha: ref.object.sha });
    },
    release: (releaseId) => request("GET", `/releases/${id(releaseId)}`),
    releases: () => request("GET", "/releases?per_page=100"),
    verifyAttestationCapability: () => verifyAttestationCapability(runGh),
    // Only the already-retained draft can become immutable. No asset/tag
    // replacement, creation, retry or write after immutability is exposed.
    publishDraft: (releaseId) => publishDraft(request, releaseId),
    verifyImmutableAttestation: (releaseId, expectedAssets, tagObjectSha) =>
      verifyImmutableAttestation(
        runGh,
        releaseId,
        expectedAssets,
        tagObjectSha,
      ),
    async readAsset(assetId) {
      return request(
        "GET",
        `/releases/assets/${id(assetId)}`,
        undefined,
        false,
        true,
      );
    },
    assets,
    async createDraft(sourceRevision, transactionId) {
      if (
        !/^[a-f0-9]{40}$/u.test(sourceRevision) ||
        !/^[a-z0-9-]{1,80}$/u.test(transactionId)
      )
        fail();
      return request("POST", "/releases", {
        tag_name: "v0.1.0",
        target_commitish: sourceRevision,
        name: `agentscope alpha ${transactionId}`,
        draft: true,
        prerelease: true,
      });
    },
    async appendAsset(releaseId, name, bytes) {
      if (
        !/^[a-z0-9.-]{1,120}$/u.test(name) ||
        !Buffer.isBuffer(bytes) ||
        bytes.length > 52_428_800
      )
        fail();
      if ((await assets(releaseId)).some((entry) => entry.name === name))
        fail();
      const uploaded = await request(
        "POST",
        `/releases/${id(releaseId)}/assets?name=${encodeURIComponent(name)}`,
        bytes,
        true,
      );
      const found = (await assets(releaseId)).filter(
        (entry) => entry.name === name,
      );
      if (
        found.length !== 1 ||
        found[0].id !== uploaded.id ||
        found[0].state !== "uploaded" ||
        found[0].size !== bytes.length ||
        found[0].digest !== sha256(bytes)
      )
        fail();
      // Release asset metadata is not sufficient evidence of durable bytes.
      // This fixed API read may fail if GitHub redirects: that is unresolved,
      // never an excuse to follow an arbitrary download URL.
      const readback = await request(
        "GET",
        `/releases/assets/${id(uploaded.id)}`,
        undefined,
        false,
        true,
      );
      if (!readback.equals(bytes)) fail();
      return Object.freeze({
        id: uploaded.id,
        name,
        digest: sha256(bytes),
        size: bytes.length,
      });
    },
  });
}
