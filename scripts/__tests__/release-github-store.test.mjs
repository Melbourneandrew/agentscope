import { test, expect } from "vitest";
import { createGitHubReleaseStore } from "../release-lane/github-release-store.mjs";
import { sha256 } from "../release-lane/validation.mjs";

function bootstrapTreeFixture(location = "bootstrap") {
  const commit = "a".repeat(40);
  const root = "b".repeat(40);
  const records = "c".repeat(40);
  const bootstrap = "d".repeat(40);
  const entry = (path, sha) => ({ path, sha, type: "tree", mode: "040000" });
  const tree = (sha, entries) => ({ sha, truncated: false, tree: entries });
  const ref = {
    ref: "refs/heads/main",
    object: { type: "commit", sha: commit },
  };
  const values = {
    "/git/ref/heads/main": ref,
    [`/git/commits/${commit}`]: { sha: commit, tree: { sha: root } },
    [`/git/trees/${root}`]: tree(
      root,
      location === "root" ? [] : [entry("release-records", records)],
    ),
    [`/git/trees/${records}`]: tree(
      records,
      location === "records" ? [] : [entry("bootstrap", bootstrap)],
    ),
    [`/git/trees/${bootstrap}`]: tree(bootstrap, []),
  };
  const calls = [];
  let refReads = 0;
  const state = { fail: false, changed: false };
  const store = createGitHubReleaseStore({
    token: "synthetic-only",
    deadline: performance.now() + 1000,
    fetchImpl: async (url, options) => {
      expect(options.method).toBe("GET");
      const path = url.slice(
        "https://api.github.com/repos/Melbourneandrew/agentscope".length,
      );
      calls.push(path);
      if (state.fail) return new Response("missing", { status: 404 });
      if (path === "/git/ref/heads/main" && ++refReads > 1 && state.changed)
        return Response.json({
          ...ref,
          object: { type: "commit", sha: "e".repeat(40) },
        });
      return Response.json(values[path]);
    },
  });
  return { store, values, calls, state, commit, root, records, bootstrap };
}

test.each(["root", "records", "bootstrap"])(
  "complete current-main %s absence closes only the bootstrap exclusion",
  async (location) => {
    const f = bootstrapTreeFixture(location);
    await expect(
      f.store.assertNoBootstrapTransaction(),
    ).resolves.toBeUndefined();
    expect(f.calls[0]).toBe("/git/ref/heads/main");
    expect(f.calls.at(-1)).toBe("/git/ref/heads/main");
    expect(f.calls.filter((path) => path.includes("/git/commits/"))).toEqual([
      `/git/commits/${f.commit}`,
    ]);
    expect(
      f.calls.some((path) => /recursive|contents|assets/u.test(path)),
    ).toBe(false);
  },
);

test.each([
  "present",
  "truncated",
  "tree-sha",
  "duplicate",
  "null-entry",
  "records-blob",
  "bootstrap-symlink",
  "commit-sha",
  "child-sha",
  "ref-type",
  "ref-name",
  "path",
  "missing-response",
  "main-changed",
])(
  "bootstrap %s cannot mint absence from current-main metadata",
  async (kind) => {
    const f = bootstrapTreeFixture();
    const root = f.values[`/git/trees/${f.root}`];
    const records = f.values[`/git/trees/${f.records}`];
    if (kind === "present")
      f.values[`/git/trees/${f.bootstrap}`].tree.push({
        path: "intent.json",
        type: "blob",
        mode: "100644",
        sha: "f".repeat(40),
      });
    if (kind === "truncated") root.truncated = true;
    if (kind === "tree-sha") root.sha = "f".repeat(40);
    if (kind === "duplicate") root.tree.push({ ...root.tree[0] });
    if (kind === "null-entry") root.tree.push(null);
    if (kind === "records-blob")
      Object.assign(root.tree[0], { type: "blob", mode: "100644" });
    if (kind === "bootstrap-symlink")
      Object.assign(records.tree[0], { type: "blob", mode: "120000" });
    if (kind === "commit-sha")
      f.values[`/git/commits/${f.commit}`].sha = "f".repeat(40);
    if (kind === "child-sha") root.tree[0].sha = "invalid";
    if (kind === "ref-type")
      f.values["/git/ref/heads/main"].object.type = "tag";
    if (kind === "ref-name")
      f.values["/git/ref/heads/main"].ref = "refs/heads/other";
    if (kind === "path") root.tree[0].path = "release-records/../bootstrap";
    f.state.fail = kind === "missing-response";
    f.state.changed = kind === "main-changed";
    await expect(f.store.assertNoBootstrapTransaction()).rejects.toThrow(
      "release.store.unresolved",
    );
  },
);

test.each(["supported", "old-version", "fallback-help"])(
  "standard gh capability preflight %s",
  async (kind) => {
    const calls = [];
    const store = createGitHubReleaseStore({
      token: "synthetic-only",
      deadline: performance.now() + 1000,
      execFileImpl: (_file, args, options, callback) => {
        calls.push(args);
        expect(options.env.GH_TOKEN).toBeUndefined();
        const output =
          args[0] === "--version"
            ? `gh version ${kind === "old-version" ? "2.69.0" : "2.83.2"} (synthetic)\n`
            : kind === "fallback-help"
              ? "Work seamlessly with GitHub releases."
              : "Verify that a GitHub Release is accompanied by a valid cryptographically signed attestation.\n--format string";
        callback(null, Buffer.from(output), Buffer.alloc(0));
        return { kill() {} };
      },
      fetchImpl: () => {
        throw new Error("must-not-contact-api");
      },
    });
    if (kind === "supported")
      expect(await store.verifyAttestationCapability()).toMatch(/^sha256:/u);
    else await expect(store.verifyAttestationCapability()).rejects.toThrow();
    expect(calls).toEqual(
      kind === "old-version"
        ? [["--version"]]
        : [["--version"], ["release", "verify", "--help"]],
    );
  },
);

test.each([false, true])(
  "one draft publish PATCH reconciles even with uncertain response %s",
  async (uncertain) => {
    const calls = [];
    let reads = 0;
    const store = createGitHubReleaseStore({
      token: "synthetic-only",
      deadline: performance.now() + 1000,
      fetchImpl: async (url, options) => {
        calls.push([url, options.method, options.body]);
        if (options.method === "PATCH") {
          if (uncertain) throw new Error("ambiguous");
          return Response.json({ id: 7 });
        }
        return Response.json({
          id: 7,
          draft: reads++ === 0,
          immutable: reads > 1,
          prerelease: true,
          tag_name: "v0.1.0",
        });
      },
    });
    const result = await store.publishDraft(7);
    expect(result.release.immutable).toBe(true);
    expect(result.uncertain).toBe(uncertain);
    expect(calls.map((entry) => entry[1])).toEqual(["GET", "PATCH", "GET"]);
    expect(calls[1][2]).toBe('{"draft":false}');
  },
);
test("immutable or foreign release refuses before PATCH", async () => {
  for (const change of [
    { immutable: true },
    { id: 8 },
    { tag_name: "v0.2.0" },
    { draft: false },
  ]) {
    const calls = [];
    const store = createGitHubReleaseStore({
      token: "synthetic-only",
      deadline: performance.now() + 1000,
      fetchImpl: async (_url, options) => {
        calls.push(options.method);
        return Response.json({
          id: 7,
          draft: true,
          immutable: false,
          prerelease: true,
          tag_name: "v0.1.0",
          ...change,
        });
      },
    });
    await expect(store.publishDraft(7)).rejects.toThrow();
    expect(calls).toEqual(["GET"]);
  }
});

function signedReleaseFixture() {
  const tag = "b".repeat(40);
  const asset = {
    name: "candidate-manifest.json",
    digest: `sha256:${"a".repeat(64)}`,
  };
  const statement = {
    predicateType: "https://in-toto.io/attestation/release/v0.1",
    predicate: {
      ownerId: "25971425",
      releaseId: "7",
      repository: "Melbourneandrew/agentscope",
      tag: "v0.1.0",
      purl: "pkg:github/Melbourneandrew/agentscope@v0.1.0",
    },
    subject: [
      {
        uri: "pkg:github/Melbourneandrew/agentscope@v0.1.0",
        digest: { sha1: tag },
      },
      { name: asset.name, digest: { sha256: asset.digest.slice(7) } },
    ],
  };
  const output = () =>
    Buffer.from(
      JSON.stringify({
        verificationResult: { syntheticTestVerifier: true },
        attestation: {
          bundle: {
            dsseEnvelope: {
              payloadType: "application/vnd.in-toto+json",
              payload: Buffer.from(JSON.stringify(statement)).toString(
                "base64",
              ),
            },
          },
        },
      }),
    );
  return { tag, asset, statement, output };
}
test("standard gh verified output binds tag/release/all assets and isolated fixed invocation", async () => {
  const f = signedReleaseFixture();
  let home;
  const store = createGitHubReleaseStore({
    token: "synthetic-only",
    deadline: performance.now() + 1000,
    execFileImpl: (file, args, options, callback) => {
      expect(file).toBe("gh");
      expect(args).toEqual([
        "release",
        "verify",
        "v0.1.0",
        "--repo",
        "Melbourneandrew/agentscope",
        "--format",
        "json",
      ]);
      expect(options.env.GH_TOKEN).toBe("synthetic-only");
      expect(options.env.GH_HOST).toBe("github.com");
      expect(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      home = options.env.HOME;
      callback(null, f.output());
    },
  });
  expect(await store.verifyImmutableAttestation(7, [f.asset], f.tag)).toBe(
    sha256(f.output()),
  );
  expect(home).toContain("agentscope-release-attestation-");
});
test.each(["tag", "release", "asset", "duplicate"])(
  "verified attestation %s mismatch cannot complete",
  async (kind) => {
    const f = signedReleaseFixture();
    if (kind === "tag") f.statement.predicate.tag = "v0.2.0";
    if (kind === "release") f.statement.predicate.releaseId = "8";
    if (kind === "asset") f.statement.subject[1].digest.sha256 = "c".repeat(64);
    if (kind === "duplicate") f.statement.subject.push(f.statement.subject[1]);
    const store = createGitHubReleaseStore({
      token: "synthetic-only",
      deadline: performance.now() + 1000,
      execFileImpl: (_file, _args, _options, callback) =>
        callback(null, f.output()),
    });
    await expect(
      store.verifyImmutableAttestation(7, [f.asset], f.tag),
    ).rejects.toThrow();
  },
);
test("attestation expected-array accessors and proxies refuse without execution", async () => {
  let getters = 0;
  let calls = 0;
  const values = [];
  Object.defineProperty(values, "0", {
    get() {
      getters++;
      return {};
    },
  });
  const store = createGitHubReleaseStore({
    token: "synthetic-only",
    deadline: performance.now() + 1000,
    execFileImpl: () => {
      calls++;
    },
  });
  await expect(
    store.verifyImmutableAttestation(7, values, "b".repeat(40)),
  ).rejects.toThrow();
  await expect(
    store.verifyImmutableAttestation(
      7,
      new Proxy([], {
        get() {
          getters++;
        },
      }),
      "b".repeat(40),
    ),
  ).rejects.toThrow();
  expect(getters).toBe(0);
  expect(calls).toBe(0);
});

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
