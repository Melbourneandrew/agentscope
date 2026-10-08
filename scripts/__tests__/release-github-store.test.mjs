import { test, expect } from "vitest";
import { createGitHubReleaseStore } from "../release-lane/github-release-store.mjs";
import { sha256 } from "../release-lane/validation.mjs";

test("never retries an ambiguous upload", async () => {
  const calls = [];
  const store = createGitHubReleaseStore({
    token: "test-only",
    deadline: performance.now() + 1000,
    fetchImpl: async (url, options) => {
      calls.push([url, options.method]);
      if (options.method === "POST") throw new Error("unknown");
      return new Response("[]");
    },
  });
  await expect(
    store.appendAsset(1, "release-record-000001.json", Buffer.from("a")),
  ).rejects.toThrow("release.store.unresolved");
  expect(calls.map((entry) => entry[1])).toEqual(["GET", "POST"]);
});
test("reads back exact unique asset bytes", async () => {
  const bytes = Buffer.from("record\n");
  let lists = 0;
  const asset = {
    id: 2,
    name: "release-record-000001.json",
    state: "uploaded",
    size: bytes.length,
    digest: sha256(bytes),
  };
  const store = createGitHubReleaseStore({
    token: "test-only",
    deadline: performance.now() + 1000,
    fetchImpl: async (url, options) => {
      expect(
        url.startsWith(
          "https://api.github.com/repos/Melbourneandrew/agentscope/",
        ) ||
          url.startsWith(
            "https://uploads.github.com/repos/Melbourneandrew/agentscope/",
          ),
      ).toBe(true);
      expect(options.redirect).toBe("error");
      if (options.headers.Accept === "application/octet-stream")
        return new Response(bytes);
      if (options.method === "POST") return Response.json(asset);
      return Response.json(lists++ === 0 ? [] : [asset]);
    },
  });
  expect(await store.appendAsset(1, asset.name, bytes)).toEqual({
    id: 2,
    name: asset.name,
    size: bytes.length,
    digest: sha256(bytes),
  });
});
test("deadline prevents acquisition", async () => {
  let calls = 0;
  const store = createGitHubReleaseStore({
    token: "test-only",
    deadline: performance.now() - 1,
    fetchImpl: async () => {
      calls++;
      return Response.json([]);
    },
  });
  await expect(store.assets(1)).rejects.toThrow();
  expect(calls).toBe(0);
});

test("probe source uses protected-main ancestry without fabricating a product tag", async () => {
  const source = "a".repeat(40);
  for (const status of ["ahead", "identical", "behind", "diverged"]) {
    const calls = [];
    const store = createGitHubReleaseStore({
      token: "test-only",
      deadline: performance.now() + 1000,
      fetchImpl: async (url, options) => {
        calls.push([url, options.method]);
        return Response.json({ status, merge_base_commit: { sha: source } });
      },
    });
    const result = store.protectedMainSource(source);
    if (["ahead", "identical"].includes(status)) await result;
    else await expect(result).rejects.toThrow("release.store.unresolved");
    expect(calls).toEqual([
      [
        `https://api.github.com/repos/Melbourneandrew/agentscope/compare/${source}...main`,
        "GET",
      ],
    ]);
  }
});

test("main ancestry rejects substituted merge base and arbitrary source selectors", async () => {
  const calls = [];
  const store = createGitHubReleaseStore({
    token: "test-only",
    deadline: performance.now() + 1000,
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({
        status: "ahead",
        merge_base_commit: { sha: "b".repeat(40) },
      });
    },
  });
  await expect(store.protectedMainSource("a".repeat(40))).rejects.toThrow();
  await expect(store.protectedMainSource("main")).rejects.toThrow();
  await expect(
    store.protectedMainSource({
      toString() {
        throw new Error("must-not-coerce");
      },
    }),
  ).rejects.toThrow("release.store.unresolved");
  expect(calls).toHaveLength(1);
});

test("product source still requires the exact annotated tag before ancestry", async () => {
  const source = "a".repeat(40);
  const tag = "b".repeat(40);
  for (const taggedSource of [source, "c".repeat(40)]) {
    const calls = [];
    const store = createGitHubReleaseStore({
      token: "test-only",
      deadline: performance.now() + 1000,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith("/git/ref/tags/v0.1.0"))
          return Response.json({ object: { type: "tag", sha: tag } });
        if (url.endsWith(`/git/tags/${tag}`))
          return Response.json({
            tag: "v0.1.0",
            object: { type: "commit", sha: taggedSource },
          });
        return Response.json({
          status: "identical",
          merge_base_commit: { sha: source },
        });
      },
    });
    const result = store.protectedSource(source);
    if (taggedSource === source) await result;
    else await expect(result).rejects.toThrow("release.store.unresolved");
    const prefix = "https://api.github.com/repos/Melbourneandrew/agentscope";
    expect(calls).toEqual([
      `${prefix}/git/ref/tags/v0.1.0`,
      `${prefix}/git/tags/${tag}`,
      ...(taggedSource === source
        ? [`${prefix}/compare/${source}...main`]
        : []),
    ]);
  }
});
