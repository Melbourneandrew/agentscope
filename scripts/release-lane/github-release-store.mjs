import { sha256 } from "./validation.mjs";

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

export function createGitHubReleaseStore({
  token,
  deadline,
  fetchImpl = fetch,
}) {
  const request = createRequest({ token, deadline, fetchImpl });
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
    },
    release: (releaseId) => request("GET", `/releases/${id(releaseId)}`),
    releases: () => request("GET", "/releases?per_page=100"),
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
