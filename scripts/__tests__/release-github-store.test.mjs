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
