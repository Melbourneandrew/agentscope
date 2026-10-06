import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

import { buildArgumentsFor } from "../image-preparation/build-policy.mjs";
import { withBuildBase } from "../image-preparation/build-base.mjs";

const image =
  "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2";
const selected =
  "sha256:bb6834c0669aa71cbc8d94606561a721adf489f6b93d7b8b825f0cf1b498c2c4";
const sha = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const readSource = (path: string) =>
  fs.readFileSync(new URL(path, import.meta.url), "utf8");
const source = readSource("../image-preparation/build-base.mjs");
type Base = { context: string; validate: () => void } | undefined;
function fixture(bindingFailure = false) {
  const root = fs.realpathSync(
    fs.mkdtempSync(resolve(tmpdir(), "agentscope-build-base-test-")),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const context = resolve(root, "context");
  fs.mkdirSync(context, { mode: 0o700 });
  const layers = Array.from({ length: 8 }, (_, index) =>
    Buffer.from(`layer-${index}`),
  );
  const files = [
    Buffer.from("root"),
    Buffer.from("manifest"),
    Buffer.from("config"),
  ];
  const material = {
    proof: { bound: true },
    layers: layers.map((bytes) => ({ digest: sha(bytes), size: bytes.length })),
    files: [
      ...files.map((bytes) => [sha(bytes), bytes]),
      ["index.json", Buffer.from("index")],
      ["oci-layout", Buffer.from("layout")],
    ],
  };
  const total = [
    ...files,
    ...layers,
    Buffer.from("index"),
    Buffer.from("layout"),
  ].reduce((sum, bytes) => sum + bytes.length, 0);
  let acquired = 0;
  let uncertain = false;
  let mutation = (_bytes: Buffer) => {};
  const invoke = runInNewContext(
    source
      .slice(source.indexOf("const image ="))
      .replace(
        "const totalBytes = 405_976_201;",
        `const totalBytes = ${total};`,
      )
      .replace("const proofObjects =", "const proofObjectsOriginal =")
      .replace("export const withBuildBase", "const withBuildBase") +
      "\nwithBuildBase;",
    {
      ...fs,
      lstatSync: (path: string, options: { bigint: true }) => {
        if (
          bindingFailure &&
          path.startsWith(resolve(root, "agentscope-build-base-"))
        )
          throw new Error("synthetic-binding");
        return fs.lstatSync(path, options);
      },
      Buffer,
      createHash,
      randomBytes,
      resolve,
      dirname: (path: string) => resolve(path, ".."),
      performance,
      process,
      fixedError: (code: string) => new Error(code),
      proofObjects: () => material,
      registryTransport: {},
      acquireManifestProof: () => Promise.resolve(material.proof),
      acquireNodeBaseLayer: async (layer: { digest: string }) => {
        await Promise.resolve();
        acquired += 1;
        const bytes = Buffer.from(
          layers.find((value) => sha(value) === layer.digest)!,
        );
        mutation(bytes);
        return bytes;
      },
    },
    { timeout: 1000 },
  ) as typeof withBuildBase;
  const input = {
    baseImage: image,
    signal: new AbortController().signal,
    context,
    client: {
      evidence: {
        images: [{ image, platform: { os: "linux", architecture: "amd64" } }],
      },
    },
    policy: {
      workDeadline: performance.now() + 2000,
      deadline: performance.now() + 3000,
    },
  };
  return {
    root,
    context,
    input,
    invoke,
    mark: () => {
      uncertain = true;
    },
    canRemove: () => !uncertain,
    state: () => ({ acquired, uncertain }),
    mutate: (next: typeof mutation) => {
      mutation = next;
    },
  };
}

const execute = (
  f: ReturnType<typeof fixture>,
  operation: (base: Base) => Promise<unknown>,
) => f.invoke(f.input, operation, f.mark, f.canRemove);

describe("same-authority finite OCI base input", () => {
  it("preserves the ordinary no-base path without filesystem or acquisition", async () => {
    const result = await withBuildBase(
      {
        client: undefined,
        context: "missing",
        policy: { workDeadline: 0, deadline: 0 },
      },
      async (base) => {
        await Promise.resolve();
        expect(base).toBeUndefined();
        return "ordinary";
      },
      () => {
        throw new Error("unexpected");
      },
      () => false,
    );
    expect(result).toBe("ordinary");
  });

  it("authenticates thirteen independent files, fixed selected context, and removes only its root", async () => {
    const f = fixture();
    expect(
      await execute(f, async (base) => {
        await Promise.resolve();
        expect(base!.context).toMatch(
          new RegExp(
            `^oci-layout://${f.root}/agentscope-build-base-[a-f\\d]{16}@${selected}$`,
            "u",
          ),
        );
        const path = base!.context.slice("oci-layout://".length).split("@")[0]!;
        expect(fs.readdirSync(path).sort()).toEqual([
          "blobs",
          "index.json",
          "oci-layout",
        ]);
        expect(fs.readdirSync(resolve(path, "blobs/sha256"))).toHaveLength(11);
        expect(fs.statSync(resolve(path, "index.json")).mode & 0o777).toBe(
          0o600,
        );
        base!.validate();
        return "built";
      }),
    ).toBe("built");
    expect(f.state()).toEqual({ acquired: 8, uncertain: false });
    expect(fs.readdirSync(f.root)).toEqual(["context"]);
  });

  it.each(["substitution", "extra", "symlink", "mode"])(
    "retains substituted input and marks uncertainty: %s",
    async (kind) => {
      const f = fixture();
      await expect(
        execute(f, async (base) => {
          await Promise.resolve();
          const path = base!.context
            .slice("oci-layout://".length)
            .split("@")[0]!;
          const target = resolve(path, "index.json");
          if (kind === "substitution") fs.writeFileSync(target, "other");
          else if (kind === "extra")
            fs.writeFileSync(resolve(path, "extra"), "canary");
          else if (kind === "mode") fs.chmodSync(target, 0o644);
          else {
            fs.unlinkSync(target);
            fs.symlinkSync(resolve(f.root, "absent"), target);
          }
          return "not-admitted";
        }),
      ).rejects.toThrow("integration.images.build.base");
      expect(f.state().uncertain).toBe(true);
      expect(fs.readdirSync(f.root)).toHaveLength(2);
    },
  );
});

describe("OCI input failure and cutoff settlement", () => {
  it("rejects a late successful build before publishing and quarantines expired cleanup", async () => {
    const f = fixture();
    await expect(
      execute(f, async () => {
        await Promise.resolve();
        f.input.policy.deadline = 0;
        return "late";
      }),
    ).rejects.toThrow("integration.images.timeout");
    expect(f.state().uncertain).toBe(true);
    expect(fs.readdirSync(f.root)).toHaveLength(2);
  });

  it("rejects caller-selected base and digest-shaped unauthenticated proof before mutation", async () => {
    const f = fixture();
    const invalid = { ...f.input, baseImage: "node@sha256:" + "a".repeat(64) };
    await expect(
      withBuildBase(
        invalid,
        async () => Promise.resolve("wrong"),
        f.mark,
        f.canRemove,
      ),
    ).rejects.toThrow("integration.images.build.base");
    await expect(
      withBuildBase(
        {
          ...f.input,
          client: { evidence: { images: [{ image, platform: {} }] } },
        },
        async () => Promise.resolve("wrong"),
        f.mark,
        f.canRemove,
      ),
    ).rejects.toThrow("integration.images.evidence");
    expect(fs.readdirSync(f.root)).toEqual(["context"]);
  });

  it("preserves exact joined build failure while cleaning its known input", async () => {
    const f = fixture();
    const primary = new Error("synthetic-primary");
    await expect(execute(f, () => Promise.reject(primary))).rejects.toBe(
      primary,
    );
    expect(f.state().uncertain).toBe(false);
    expect(fs.readdirSync(f.root)).toEqual(["context"]);
  });

  it("does not delete a live session input after failed containment", async () => {
    const f = fixture();
    const primary = new Error("unjoined");
    await expect(
      execute(f, async () => {
        await Promise.resolve();
        f.mark();
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(fs.readdirSync(f.root)).toHaveLength(2);
    expect(f.state().uncertain).toBe(true);
  });

  it("rejects changed layer bytes before builder invocation and cleans known prefix", async () => {
    const f = fixture();
    f.mutate((bytes) => {
      bytes[0] = bytes[0]! ^ 1;
    });
    let called = false;
    await expect(
      execute(f, async () => {
        await Promise.resolve();
        called = true;
      }),
    ).rejects.toThrow("integration.images.build.base");
    expect(called).toBe(false);
    expect(f.state().acquired).toBe(1);
    expect(fs.readdirSync(f.root)).toEqual(["context"]);
  });
});

describe("OCI original cutoff before physical admission", () => {
  it("quarantines mkdir success whose physical root binding fails", async () => {
    const f = fixture(true);
    let called = false;
    await expect(
      execute(f, () => {
        called = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("integration.images.build.base");
    expect(called).toBe(false);
    expect(f.state().uncertain).toBe(true);
    expect(fs.readdirSync(f.root)).toHaveLength(2);
  });
  it.each(["expiry", "abort"])(
    "shares original cutoff and refuses later invocation: %s",
    async (kind) => {
      const f = fixture();
      const abort = new AbortController();
      f.input.signal = abort.signal;
      if (kind === "expiry") f.input.policy.workDeadline = 0;
      else abort.abort();
      let called = false;
      await expect(
        execute(f, async () => {
          await Promise.resolve();
          called = true;
        }),
      ).rejects.toThrow(
        kind === "expiry"
          ? "integration.images.timeout"
          : "integration.images.interrupted",
      );
      expect(called).toBe(false);
      expect(f.state().acquired).toBe(0);
      expect(fs.readdirSync(f.root)).toEqual(["context"]);
    },
  );
});

describe("fixed named input uses the existing buildx call", () => {
  const options = {
    buildArguments: {},
    buildNetwork: "none" as const,
    builder: "owned",
    dockerfile: "Verifier.Dockerfile",
    labels: {},
    platform: { os: "linux", architecture: "amd64" },
    tag: "owned:run",
  };
  it("adds exactly one OCI session input at the actual validated build call", async () => {
    const context = `oci-layout:///owned/base@${selected}`;
    const original = buildArgumentsFor(options);
    const changed = buildArgumentsFor({ ...options, baseContext: context });
    expect(
      changed.filter(
        (value, index) =>
          index !== changed.indexOf("--build-context") &&
          index !== changed.indexOf("--build-context") + 1,
      ),
    ).toEqual(original);
    expect(changed).toContain(`agentscope_base=${context}`);
    const text = readSource("../image-preparation/docker.mjs");
    const body = text.slice(
      text.indexOf('    authority.currentOperationKind = "image-build";'),
      text.indexOf(
        "    const built =",
        text.indexOf("  const executeBuilderBuild ="),
      ),
    );
    const calls: unknown[] = [];
    await runInNewContext(
      `(async () => { ${body} })()`,
      {
        authority: { buildNetwork: "none", buildOutput: "evidence-tar" },
        options: {
          ...options,
          baseInput: { context, validate: () => calls.push("validated") },
        },
        builder: options.builder,
        buildkit: { platform: options.platform },
        buildArgumentsFor,
        archive: Buffer.from("bounded-context"),
        policy: { workDeadline: 1234 },
        run: (...args: [string[], Buffer, number, string]) => {
          const [argv, , deadline, format] = args;
          calls.push({ argv, deadline, format });
          return Promise.resolve(Buffer.alloc(0));
        },
      },
      { timeout: 1000 },
    );
    expect(calls).toEqual([
      "validated",
      {
        argv: buildArgumentsFor({
          ...options,
          buildOutput: "evidence-tar",
          baseContext: context,
        }),
        deadline: 1234,
        format: "binary",
      },
    ]);
  });
});

describe("same registry blob kernel owns the closed Node layer request", () => {
  function layerReader(response: Buffer, redirect = false) {
    const calls: Record<string, unknown>[] = [];
    const text = readSource("../image-preparation/registry.mjs");
    const body = text.slice(
      text.indexOf("const fetchRegistryBlob ="),
      text.indexOf("export const acquireManifestProof ="),
    );
    const read = runInNewContext(
      body.replace(
        "export const acquireNodeBaseLayer",
        "const acquireNodeBaseLayer",
      ) + "\nacquireNodeBaseLayer;",
      {
        digestPattern: /^sha256:[a-f\d]{64}$/u,
        maximumManifestBytes: 65536,
        fixedError: (code: string) => new Error(code),
        parseImageReference: () => ({
          name: "library/node",
          origin: "https://registry.invalid",
        }),
        allowedBlobRedirect: () => new URL("https://cdn.invalid/exact"),
        digestBytes: sha,
        requestWith: (
          _transport: unknown,
          request: Record<string, unknown>,
        ) => {
          calls.push(request);
          return Promise.resolve(
            redirect && calls.length === 1
              ? {
                  statusCode: 307,
                  headers: { location: "https://cdn.invalid/exact" },
                  body: Buffer.alloc(0),
                }
              : {
                  statusCode: 200,
                  headers: { "content-type": "application/octet-stream" },
                  body: response,
                },
          );
        },
      },
      { timeout: 1000 },
    ) as (input: object) => Promise<Buffer>;
    return { read, calls };
  }

  it.each([false, true])(
    "uses the exact size, original clock and no forwarded CDN credential: %s",
    async (redirect) => {
      const bytes = Buffer.from("synthetic-layer");
      const r = layerReader(bytes, redirect);
      const signal = new AbortController().signal;
      expect(
        await r.read({
          image,
          digest: sha(bytes),
          size: bytes.length,
          policy: { workDeadline: 1234 },
          signal,
          tokenCache: new Map([["library/node", "synthetic"]]),
          transport: {},
        }),
      ).toEqual(bytes);
      expect(r.calls).toHaveLength(redirect ? 2 : 1);
      for (const call of r.calls) {
        expect(call.maximumBytes).toBe(bytes.length);
        expect(call.deadline).toBe(1234);
        expect(call.signal).toBe(signal);
      }
      if (redirect)
        expect(r.calls[1]!.headers).toEqual({
          Accept: "application/octet-stream",
        });
    },
  );

  it.each([0, 211394365, 1.5])(
    "rejects unbounded size before any request: %s",
    async (size) => {
      const r = layerReader(Buffer.from("canary"));
      await expect(
        r.read({ image, digest: sha(Buffer.from("canary")), size }),
      ).rejects.toThrow("integration.images.build.base");
      expect(r.calls).toHaveLength(0);
    },
  );

  it("rejects changed bytes and declared size mismatch instead of adopting observed hashes", async () => {
    const bytes = Buffer.from("canary");
    const r = layerReader(bytes);
    const input = {
      image,
      digest: sha(bytes),
      size: bytes.length + 1,
      policy: { workDeadline: 1234 },
      tokenCache: new Map([["library/node", "synthetic"]]),
      transport: {},
    };
    await expect(r.read(input)).rejects.toThrow(
      "integration.images.build.base",
    );
    await expect(
      r.read({
        ...input,
        size: bytes.length,
        digest: sha(Buffer.from("other")),
      }),
    ).rejects.toThrow("integration.images.config");
  });
});
