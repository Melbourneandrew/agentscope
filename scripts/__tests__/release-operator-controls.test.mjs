import { expect, test, vi } from "vitest";
import { inspectOperatorReleaseControls } from "../release-lane/operator-controls.mjs";
import { sha256 } from "../release-lane/validation.mjs";

const repository = "Melbourneandrew/agentscope";
const owner = { id: 25971425, login: "Melbourneandrew", type: "User" };
const bytes = (value) => Buffer.from(JSON.stringify(value));
const response = (value) =>
  Buffer.concat([
    Buffer.from("HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n"),
    bytes(value),
  ]);

function documents() {
  const scope = {
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    source: repository,
    source_type: "Repository",
  };
  const contexts = [
    "hermetic-integration",
    "Quality",
    "Unit tests",
    "Documentation",
    "Native candidate verification",
  ];
  return new Map([
    ["user", owner],
    [`repos/${repository}/rulesets?per_page=100`, [{ id: 11 }, { id: 12 }]],
    [
      `repos/${repository}/rulesets/11`,
      {
        ...scope,
        id: 11,
        rules: [{ type: "creation" }],
        bypass_actors: [
          { actor_type: "User", actor_id: owner.id, bypass_mode: "always" },
        ],
      },
    ],
    [
      `repos/${repository}/rulesets/12`,
      {
        ...scope,
        id: 12,
        rules: [{ type: "update" }, { type: "deletion" }],
        bypass_actors: [],
      },
    ],
    [`repos/${repository}/immutable-releases`, { enabled: true }],
    [
      `repos/${repository}/branches/main/protection`,
      {
        required_status_checks: {
          strict: true,
          contexts,
          checks: contexts.map((context) => ({ context, app_id: 15368 })),
        },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      },
    ],
    [
      `repos/${repository}/environments/npm-release`,
      {
        name: "npm-release",
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [{ type: "User", reviewer: { id: owner.id } }],
          },
        ],
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      },
    ],
    [
      `repos/${repository}/environments/npm-release/deployment-branch-policies?per_page=100`,
      {
        total_count: 2,
        branch_policies: [
          { name: "main", type: "branch" },
          { name: "v*", type: "tag" },
        ],
      },
    ],
  ]);
}

function fixture(transform = (value) => value) {
  const docs = documents();
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const endpoint = args.at(-1);
    callback(
      null,
      transform(response(docs.get(endpoint)), endpoint),
      Buffer.alloc(0),
    );
  };
  return { docs, calls, execFileImpl };
}

test("fixed gh GET inventory validates actual bodies and retains only bounded attestation", async () => {
  const f = fixture();
  const before = Date.now();
  const result = await inspectOperatorReleaseControls({
    deadline: performance.now() + 5_000,
    execFileImpl: f.execFileImpl,
  });
  expect(f.calls.map((call) => call.args.at(-1))).toEqual([...f.docs.keys()]);
  for (const call of f.calls) {
    expect(call.file).toBe("gh");
    expect(call.args.slice(0, -1)).toEqual([
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
    ]);
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
      maxBuffer: 1_114_112,
      windowsHide: true,
    });
    expect(call.options.timeout).toBeGreaterThan(0);
    expect(call.options.timeout).toBeLessThanOrEqual(5_000);
  }
  expect(result).toMatchObject({
    state: "operator-controls-observed",
    repository,
    ownerId: owner.id,
    ownerLogin: owner.login,
    responseCount: 8,
  });
  expect(Date.parse(result.inspectedAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(result.inspectedAt)).toBeLessThanOrEqual(Date.now());
  expect(result.responses).toEqual(
    [...f.docs].map(([endpoint, value]) => ({
      path:
        endpoint === "user"
          ? "/user"
          : endpoint.slice(`repos/${repository}`.length),
      bytes: bytes(value).length,
      digest: sha256(bytes(value)),
    })),
  );
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.responses)).toBe(true);
  expect(result.responses.every(Object.isFrozen)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("bypass_actors");
});

test.each([
  { ...owner, id: 1 },
  { ...owner, login: "other" },
  { ...owner, type: "Organization" },
])(
  "wrong authenticated owner stops before settings acquisition: %j",
  async (value) => {
    const f = fixture();
    f.docs.set("user", value);
    await expect(
      inspectOperatorReleaseControls({
        deadline: performance.now() + 5_000,
        execFileImpl: f.execFileImpl,
      }),
    ).rejects.toThrow("release.operator-controls.unresolved");
    expect(f.calls).toHaveLength(1);
  },
);

test.each([
  ["non-200", Buffer.from("HTTP/2.0 403 Forbidden\r\n\r\n{}")],
  [
    "redirect",
    Buffer.from(
      "HTTP/2.0 302 Found\r\nlocation: https://other.invalid\r\n\r\n{}",
    ),
  ],
  ["pagination", Buffer.from("HTTP/2.0 200 OK\r\nLink: <next>\r\n\r\n{}")],
  ["missing headers", bytes(owner)],
  [
    "control in header",
    Buffer.from("HTTP/2.0 200 OK\r\nx-header: bad\u0000value\r\n\r\n{}"),
  ],
  ["truncated JSON", Buffer.from("HTTP/2.0 200 OK\r\n\r\n{")],
  [
    "invalid UTF-8",
    Buffer.concat([
      Buffer.from("HTTP/2.0 200 OK\r\n\r\n"),
      Buffer.from([0xff]),
    ]),
  ],
  [
    "oversized body",
    Buffer.from(`HTTP/2.0 200 OK\r\n\r\n${" ".repeat(1_048_577)}`),
  ],
  [
    "oversized headers",
    Buffer.from(`HTTP/2.0 200 OK\r\nx-header: ${"a".repeat(65_536)}\r\n\r\n{}`),
  ],
])(
  "rejects %s without settings or raw response disclosure",
  async (_, output) => {
    const f = fixture(() => output);
    await expect(
      inspectOperatorReleaseControls({
        deadline: performance.now() + 5_000,
        execFileImpl: f.execFileImpl,
      }),
    ).rejects.toThrow(/^release\.operator-controls\.unresolved$/u);
    expect(f.calls).toHaveLength(1);
  },
);

test("shared settings validator rejects actual immutable false", async () => {
  const f = fixture();
  f.docs.set(`repos/${repository}/immutable-releases`, { enabled: false });
  await expect(
    inspectOperatorReleaseControls({
      deadline: performance.now() + 5_000,
      execFileImpl: f.execFileImpl,
    }),
  ).rejects.toThrow(/^release\.operator-controls\.unresolved$/u);
  expect(f.calls).toHaveLength(5);
});

test("child failure is joined and sanitized rather than raced or exposed", async () => {
  let callback;
  let settled = false;
  const pending = inspectOperatorReleaseControls({
    deadline: performance.now() + 5_000,
    execFileImpl: (_file, _args, options, done) => {
      expect(options.killSignal).toBe("SIGKILL");
      callback = done;
    },
  });
  const checked = pending.catch((error) => {
    settled = true;
    expect(error.message).toBe("release.operator-controls.unresolved");
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  callback(
    new Error("synthetic-secret-timeout"),
    Buffer.alloc(0),
    Buffer.from("synthetic-secret-stderr"),
  );
  await checked;
  expect(settled).toBe(true);
});

test("expired original deadline starts no child", async () => {
  const f = fixture();
  await expect(
    inspectOperatorReleaseControls({
      deadline: performance.now() - 1,
      execFileImpl: f.execFileImpl,
    }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("one original deadline shrinks and late settlement cannot attest completion", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const f = fixture();
  try {
    const run = (file, args, options, callback) => {
      clock.mockReturnValue(args.at(-1) === "user" ? 110 : 150);
      f.execFileImpl(file, args, options, callback);
    };
    await expect(
      inspectOperatorReleaseControls({ deadline: 150, execFileImpl: run }),
    ).rejects.toThrow();
    expect(f.calls.map((call) => call.options.timeout)).toEqual([50, 40]);
  } finally {
    clock.mockRestore();
  }
});

test("oversized stderr and synchronous executable errors are content-free failures", async () => {
  for (const execFileImpl of [
    (_file, _args, _options, callback) =>
      callback(null, response(owner), Buffer.alloc(65_537)),
    () => {
      throw new Error("synthetic-secret-spawn-error");
    },
  ]) {
    await expect(
      inspectOperatorReleaseControls({
        deadline: performance.now() + 5_000,
        execFileImpl,
      }),
    ).rejects.toThrow(/^release\.operator-controls\.unresolved$/u);
  }
});
