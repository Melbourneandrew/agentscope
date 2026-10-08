import { expect, test, vi } from "vitest";
import { produceNpmStage } from "../release-lane/npm-stage-producer.mjs";
import { validateStageResult } from "../release-lane/stage-result.mjs";

const hash = `sha256:${"a".repeat(64)}`;
const tuple = (kind = "product") => ({
  kind,
  transactionId: "transaction-1",
  candidateManifestDigest: hash,
  tarballSha256: hash,
  integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  sourceRevision: "b".repeat(40),
  protectedTag: kind === "product" ? "v0.1.0" : null,
  package: "agentscope-cli",
  version: kind === "product" ? "0.1.0" : "0.0.0-oidc-probe.nonce-1",
  distTag: kind === "product" ? "alpha" : "oidc-probe",
  workflowDigest: hash,
  releaseScriptsDigest: hash,
  ownerCheckpointDigest: hash,
});
const receipt = (binding) =>
  Buffer.from(
    JSON.stringify({
      [binding.package]: {
        id: `${binding.package}@${binding.version}`,
        name: binding.package,
        version: binding.version,
        integrity: binding.integrity,
        stageId: "stage-1",
      },
    }),
  );
function fixture(kind = "product", stage = {}) {
  const binding = tuple(kind);
  const calls = [];
  const input = {
    tuple: binding,
    tarballPath: `/retained/${binding.package}-${binding.version}.tgz`,
    deadline: performance.now() + 5_000,
    execFileImpl: (file, args, options, done) => {
      calls.push({ file, args, options });
      if (args[0] === "--version")
        done(null, Buffer.from("11.17.0\n"), Buffer.alloc(0));
      else
        done(
          stage.error ?? null,
          stage.stdout ?? receipt(binding),
          stage.stderr ?? Buffer.alloc(0),
        );
    },
  };
  return { binding, calls, input };
}

test.each(["product", "probe"])(
  "single exact standard npm command for %s",
  async (kind) => {
    const f = fixture(kind);
    const result = await produceNpmStage(f.input);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map(({ file }) => file)).toEqual(["npm", "npm"]);
    expect(f.calls[0].args).toEqual(["--version"]);
    expect(f.calls[1].args).toEqual([
      "stage",
      "publish",
      f.input.tarballPath,
      "--json",
      "--tag",
      f.binding.distTag,
      "--provenance",
      "--ignore-scripts",
      "--registry",
      "https://registry.npmjs.org",
    ]);
    for (const call of f.calls) {
      expect(Object.keys(call.options).sort()).toEqual([
        "encoding",
        "killSignal",
        "maxBuffer",
        "timeout",
        "windowsHide",
      ]);
      expect(call.options).toMatchObject({
        encoding: "buffer",
        killSignal: "SIGKILL",
        windowsHide: true,
      });
      expect(call.options.timeout).toBeGreaterThan(0);
      expect(call.options.timeout).toBeLessThanOrEqual(5_000);
    }
    expect(f.calls.map(({ options }) => options.maxBuffer)).toEqual([
      65_536, 1_048_576,
    ]);
    expect(result).toEqual({
      schemaVersion: 1,
      tuple: f.binding,
      response: "received",
      stageId: "stage-1",
    });
    expect(validateStageResult(result, f.binding).stageId).toBe("stage-1");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tuple)).toBe(true);
    f.binding.distTag = "latest";
    expect(result.tuple.distTag).not.toBe("latest");
  },
);

test("retained probe filename belongs to the composition, not this utility", async () => {
  const f = fixture("probe");
  f.input.tarballPath = "/retained/inert-probe.tgz";
  expect((await produceNpmStage(f.input)).response).toBe("received");
  expect(f.calls[1].args[2]).toBe(f.input.tarballPath);
});

test.each(["11.16.0\n", "11.17.1\n", "11.17.0\nextra", "", "secret-error"])(
  "wrong version %j prevents mutation",
  async (version) => {
    const f = fixture();
    f.input.execFileImpl = (file, args, options, done) => {
      f.calls.push({ file, args, options });
      done(null, Buffer.from(version), Buffer.alloc(0));
    };
    await expect(produceNpmStage(f.input)).rejects.toThrow(
      /^release\.npm-stage\.unavailable$/u,
    );
    expect(f.calls).toHaveLength(1);
  },
);

test("version execution failure never discloses errors or reaches stage", async () => {
  const f = fixture();
  f.input.execFileImpl = (file, args, options, done) => {
    f.calls.push({ file, args, options });
    done(
      new Error("synthetic-secret"),
      Buffer.from("11.17.0\n"),
      Buffer.from("secret-stderr"),
    );
  };
  await expect(produceNpmStage(f.input)).rejects.toThrow(
    /^release\.npm-stage\.unavailable$/u,
  );
  expect(f.calls).toHaveLength(1);
});

test.each([
  [Buffer.alloc(0), "missing"],
  [Buffer.from("{"), "ambiguous"],
  [Buffer.from("{}"), "ambiguous"],
  [Buffer.from([0xff]), "ambiguous"],
  [Buffer.alloc(1_048_577), "ambiguous"],
])(
  "complete stdout is projected without a retry: %#",
  async (stdout, response) => {
    const f = fixture("product", { stdout });
    const result = await produceNpmStage(f.input);
    expect(result.response).toBe(response);
    expect(result.stageId).toBeNull();
    expect(f.calls).toHaveLength(2);
    expect(() => validateStageResult(result, f.binding)).not.toThrow();
  },
);

test.each([
  { error: new Error("synthetic-secret") },
  { stderr: Buffer.alloc(65_537) },
  { stdout: "not-buffer" },
])(
  "post-invocation failures retain ambiguity with no raw body %#",
  async (stage) => {
    const f = fixture("product", stage);
    const result = await produceNpmStage(f.input);
    expect(result.response).toBe("ambiguous");
    expect(result.stageId).toBeNull();
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(f.calls).toHaveLength(2);
  },
);

test("post-invocation synchronous exception retains uncertainty", async () => {
  const f = fixture();
  const run = f.input.execFileImpl;
  f.input.execFileImpl = (file, args, options, done) => {
    if (args[0] === "--version") return run(file, args, options, done);
    f.calls.push({ file, args, options });
    throw new Error("synthetic-secret");
  };
  expect((await produceNpmStage(f.input)).response).toBe("ambiguous");
  expect(f.calls).toHaveLength(2);
});

test("original expired deadline starts neither preflight nor stage", async () => {
  const f = fixture();
  f.input.deadline = performance.now() - 1;
  await expect(produceNpmStage(f.input)).rejects.toThrow(
    /^release\.npm-stage\.unavailable$/u,
  );
  expect(f.calls).toHaveLength(0);
});

test("version and stage share original shrinking deadline; late stage is uncertain", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const f = fixture();
  const run = f.input.execFileImpl;
  f.input.deadline = 150;
  f.input.execFileImpl = (file, args, options, done) => {
    clock.mockReturnValue(args[0] === "--version" ? 110 : 150);
    run(file, args, options, done);
  };
  try {
    expect((await produceNpmStage(f.input)).response).toBe("ambiguous");
    expect(f.calls.map(({ options }) => options.timeout)).toEqual([50, 40]);
  } finally {
    clock.mockRestore();
  }
});

test("expired version callback prevents stage", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const f = fixture();
  f.input.deadline = 150;
  f.input.execFileImpl = (file, args, options, done) => {
    f.calls.push({ file, args, options });
    clock.mockReturnValue(150);
    done(null, Buffer.from("11.17.0\n"), Buffer.alloc(0));
  };
  try {
    await expect(produceNpmStage(f.input)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

test("awaits child close callback rather than racing a detached mutation", async () => {
  const f = fixture();
  const run = f.input.execFileImpl;
  let close;
  let settled = false;
  let entered;
  const stageEntered = new Promise((resolve) => {
    entered = resolve;
  });
  f.input.execFileImpl = (file, args, options, done) => {
    if (args[0] === "--version") return run(file, args, options, done);
    f.calls.push({ file, args, options });
    close = done;
    entered();
  };
  const pending = produceNpmStage(f.input).then((value) => {
    settled = true;
    return value;
  });
  await stageEntered;
  try {
    expect(settled).toBe(false);
    expect(f.calls).toHaveLength(2);
  } finally {
    close(new Error("timeout"), Buffer.alloc(0), Buffer.alloc(0));
  }
  expect((await pending).response).toBe("ambiguous");
  expect(settled).toBe(true);
});

test.each([
  "relative.tgz",
  "/retained/other.txt",
  "/retained/agentscope-cli-0.1.0.tgz\0extra",
])("invalid tarball argument %j executes nothing", async (path) => {
  const f = fixture();
  f.input.tarballPath = path;
  await expect(produceNpmStage(f.input)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("invalid tuple/latest and hostile proxy execute nothing", async () => {
  for (const binding of [
    { ...tuple(), distTag: "latest" },
    new Proxy(tuple(), {
      get() {
        throw new Error("caller");
      },
    }),
  ]) {
    const f = fixture();
    f.input.tuple = binding;
    await expect(produceNpmStage(f.input)).rejects.toThrow(
      /^release\.npm-stage\.unavailable$/u,
    );
    expect(f.calls).toHaveLength(0);
  }
});
