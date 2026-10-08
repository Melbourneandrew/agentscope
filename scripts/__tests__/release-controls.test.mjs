import { test, expect } from "vitest";
import {
  validateImmutableReleaseResponse,
  validateMainProtection,
  validateReleaseEnvironment,
  validateTagRulesets,
  semanticTagPattern,
  inspectReleaseControlsWithGet,
} from "../release-lane/release-controls.mjs";
const bytes = (value) => Buffer.from(JSON.stringify(value));
test("actual HTTP200 enabled false is not immutable enforcement", () => {
  for (const input of [{ enabled: false }, {}, { enabled: "true" }])
    expect(() => validateImmutableReleaseResponse(bytes(input))).toThrow();
  expect(() =>
    validateImmutableReleaseResponse(bytes({ enabled: true })),
  ).not.toThrow();
});

function apiDocuments() {
  const scope = {
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    source: "Melbourneandrew/agentscope",
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
    ["/rulesets?per_page=100", [{ id: 11 }, { id: 12 }]],
    [
      "/rulesets/11",
      {
        ...scope,
        id: 11,
        rules: [{ type: "creation" }],
        bypass_actors: [
          { actor_type: "User", actor_id: 25971425, bypass_mode: "always" },
        ],
      },
    ],
    [
      "/rulesets/12",
      {
        ...scope,
        id: 12,
        bypass_actors: [],
        rules: [{ type: "update" }, { type: "deletion" }],
      },
    ],
    ["/immutable-releases", { enabled: true }],
    [
      "/branches/main/protection",
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
      "/environments/npm-release",
      {
        name: "npm-release",
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [{ type: "User", reviewer: { id: 25971425 } }],
          },
        ],
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      },
    ],
    [
      "/environments/npm-release/deployment-branch-policies?per_page=100",
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

test("fixed inspection binds full ruleset bodies through operator acquisition", async () => {
  const documents = apiDocuments();
  const calls = [];
  const result = await inspectReleaseControlsWithGet({
    deadline: performance.now() + 1000,
    get: async (path) => {
      expect(documents.has(path)).toBe(true);
      calls.push(path);
      return bytes(documents.get(path));
    },
  });
  expect(calls).toEqual([...documents.keys()]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.state).toBe("current-controls-observed");
});

test("missing, ambiguous and foreign ruleset details never certify controls", async () => {
  for (const kind of ["missing", "duplicate", "foreign"]) {
    const documents = apiDocuments();
    documents.get("/rulesets/11").source =
      kind === "foreign" ? "other/repository" : "Melbourneandrew/agentscope";
    if (kind === "missing") documents.set("/rulesets?per_page=100", []);
    if (kind === "duplicate")
      documents.set("/rulesets?per_page=100", [{ id: 11 }, { id: 11 }]);
    await expect(
      inspectReleaseControlsWithGet({
        deadline: performance.now() + 1000,
        get: async (path) => bytes(documents.get(path)),
      }),
    ).rejects.toThrow("release.controls.unresolved");
  }
});

test("expired original deadline makes no request", async () => {
  let calls = 0;
  await expect(
    inspectReleaseControlsWithGet({
      deadline: performance.now() - 1,
      get: async () => {
        calls++;
      },
    }),
  ).rejects.toThrow("release.controls.unresolved");
  expect(calls).toBe(0);
});
test("supported immutable tag rules require both update and deletion with no bypass", () => {
  for (const missing of ["update", "deletion"]) {
    const documents = apiDocuments();
    const immutable = documents.get("/rulesets/12");
    immutable.rules = immutable.rules.filter((rule) => rule.type !== missing);
    expect(() =>
      validateTagRulesets(bytes([documents.get("/rulesets/11"), immutable])),
    ).toThrow("release.controls.unresolved");
  }
  const documents = apiDocuments();
  const immutable = documents.get("/rulesets/12");
  immutable.bypass_actors = [
    { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
  ];
  expect(() =>
    validateTagRulesets(bytes([documents.get("/rulesets/11"), immutable])),
  ).toThrow("release.controls.unresolved");
});
test("preserves exact strict five main contexts and administrator enforcement", () => {
  const contexts = [
    "hermetic-integration",
    "Quality",
    "Unit tests",
    "Documentation",
    "Native candidate verification",
  ];
  const protection = {
    required_status_checks: {
      strict: true,
      contexts,
      checks: contexts.map((context) => ({ context, app_id: 15368 })),
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  expect(() => validateMainProtection(bytes(protection))).not.toThrow();
  protection.enforce_admins.enabled = false;
  expect(() => validateMainProtection(bytes(protection))).toThrow();
});
test("requires exact owner review and branch/tag environment policies", () => {
  const environment = {
    name: "npm-release",
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: { id: 25971425 } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
  const policies = {
    total_count: 2,
    branch_policies: [
      { name: "main", type: "branch" },
      { name: "v*", type: "tag" },
    ],
  };
  expect(() =>
    validateReleaseEnvironment(bytes(environment), bytes(policies)),
  ).not.toThrow();
  environment.protection_rules[0].reviewers[0].reviewer.id++;
  expect(() =>
    validateReleaseEnvironment(bytes(environment), bytes(policies)),
  ).toThrow();
});
test("layered tags do not give the creator an update/delete bypass", () => {
  const scope = {
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  };
  const rulesets = [
    {
      ...scope,
      rules: [{ type: "creation" }],
      bypass_actors: [
        { actor_type: "User", actor_id: 25971425, bypass_mode: "always" },
      ],
    },
    {
      ...scope,
      bypass_actors: [],
      rules: [{ type: "update" }, { type: "deletion" }],
    },
  ];
  expect(() => validateTagRulesets(bytes(rulesets))).not.toThrow();
  for (const tag of ["v0.1.0", "v1.2.3-alpha.1", "v1.2.3+build.1"])
    expect(new RegExp(semanticTagPattern, "u").test(tag)).toBe(true);
  for (const tag of ["v01.2.3", "v1.2.3-01", "v1.2", "v1.2.3_bad"])
    expect(new RegExp(semanticTagPattern, "u").test(tag)).toBe(false);
  rulesets[1].bypass_actors.push(rulesets[0].bypass_actors[0]);
  expect(() => validateTagRulesets(bytes(rulesets))).toThrow();
});
