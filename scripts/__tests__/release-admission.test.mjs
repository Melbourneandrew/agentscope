import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  bindPreparedCliEvidence,
  parseAdmissionDocument,
  projectOperatorControlsReport,
  requireActualSemanticAdmission,
} from "../release-lane/admission.mjs";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";

function fixture() {
  const tarball = Buffer.from("synthetic artifact binding only");
  const material = {
    evidenceVersion: 1,
    candidateRevision: "a".repeat(40),
    platform: { os: "linux", architecture: "x64", nodeVersion: "22.0.0" },
    lockfile: {
      fileName: "pnpm-lock.yaml",
      bytes: 1,
      sha256: `sha256-${"b".repeat(64)}`,
    },
    artifacts: [
      {
        id: "agentscope-cli",
        kind: "npm-tarball",
        fileName: "agentscope-cli.tgz",
        bytes: tarball.length,
        sha256: sha256(tarball).replace("sha256:", "sha256-"),
      },
    ],
    scenarioNetworkPolicy: "offline-no-package-or-registry-download",
  };
  const evidence = {
    ...material,
    bundleIdentity: sha256(canonicalJson(material)).replace(
      "sha256:",
      "sha256-",
    ),
  };
  const manifest = {
    sourceRevision: material.candidateRevision,
    tarball: {
      bytes: tarball.length,
      sha256: sha256(tarball),
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    },
  };
  return { tarball, evidence, manifest };
}
const encode = (value) => Buffer.from(JSON.stringify(value));
function controlsFixture() {
  return {
    state: "operator-controls-observed",
    repository: "Melbourneandrew/agentscope",
    ownerId: 25971425,
    ownerLogin: "Melbourneandrew",
    inspectedAt: "2026-10-08T00:00:00.000Z",
    responseCount: 8,
    responses: [
      "/user",
      "/rulesets?per_page=100",
      "/rulesets/24696278",
      "/rulesets/24696353",
      "/immutable-releases",
      "/branches/main/protection",
      "/environments/npm-release",
      "/environments/npm-release/deployment-branch-policies?per_page=100",
    ].map((path) => ({ path, bytes: 1, digest: `sha256:${"a".repeat(64)}` })),
  };
}
const controlsExpiry = "2026-10-08T00:15:00.000Z";
const controlsConsumption = "2026-10-08T00:10:00.000Z";
test("projects finite owner controls without widening recorder DTO grammar", () => {
  const report = JSON.stringify(controlsFixture());
  expect(
    projectOperatorControlsReport(report, controlsExpiry, controlsConsumption),
  ).toEqual({
    controlsReportDigest: sha256(Buffer.from(report)),
    controlsInspectedAt: "2026-10-08T00:00:00.000Z",
  });
});
test.each([
  (r) => {
    r.ownerId = 1;
  },
  (r) => {
    r.ownerLogin = "other";
  },
  (r) => {
    r.repository = "other/repository";
  },
  (r) => {
    r.responses.pop();
  },
  (r) => {
    r.responses.reverse();
  },
  (r) => {
    r.responses[3] = r.responses[2];
  },
  (r) => {
    r.responses[2].path = ["/rulesets/11"];
  },
  (r) => {
    r.responses[2].path = ["/rulesets/11"];
    r.responses[3].path = ["/rulesets/11"];
  },
  (r) => {
    r.responses[0].bytes = 1_048_577;
  },
  (r) => {
    r.responses[0].digest = "success";
  },
  (r) => {
    r.responses[0].body = "unretained settings";
  },
  (r) => {
    r.inspectedAt = "2026-10-08T00:11:00.000Z";
  },
])("rejects changed finite controls report %#", (change) => {
  const report = controlsFixture();
  change(report);
  expect(() =>
    projectOperatorControlsReport(
      JSON.stringify(report),
      controlsExpiry,
      controlsConsumption,
    ),
  ).toThrow();
});
test("does not renew an old controls report after queueing", () => {
  const report = JSON.stringify(controlsFixture());
  for (const [expires, observed] of [
    [controlsExpiry, "2026-10-08T00:15:00.001Z"],
    ["2026-10-08T00:16:00.000Z", controlsConsumption],
    [controlsExpiry, "2026-10-07T23:59:59.999Z"],
    [controlsExpiry, "invalid"],
  ])
    expect(() =>
      projectOperatorControlsReport(report, expires, observed),
    ).toThrow();
  expect(() =>
    projectOperatorControlsReport(
      " ".repeat(4097),
      controlsExpiry,
      controlsConsumption,
    ),
  ).toThrow();
});
test("binds CLI bytes independently of prepared bundle identity", () => {
  const f = fixture();
  const bound = bindPreparedCliEvidence(
    encode(f.evidence),
    encode(f.manifest),
    f.tarball,
  );
  expect(bound.cliSha256).not.toBe(bound.bundleIdentity);
  expect(Object.isFrozen(bound)).toBe(true);
});
test("rejects changed bytes, SRI, revision and duplicate CLI rows", () => {
  for (const change of [
    (f) => {
      f.tarball = Buffer.from("other");
    },
    (f) => {
      f.manifest.tarball.integrity = "sha512-wrong";
    },
    (f) => {
      f.manifest.sourceRevision = "b".repeat(40);
    },
    (f) => {
      f.evidence.artifacts.push(f.evidence.artifacts[0]);
    },
  ]) {
    const f = fixture();
    change(f);
    expect(() =>
      bindPreparedCliEvidence(
        encode(f.evidence),
        encode(f.manifest),
        f.tarball,
      ),
    ).toThrow();
  }
});
test("certified label or successful job cannot supply missing OTLP evidence", () => {
  expect(() =>
    requireActualSemanticAdmission({
      state: "certified",
      conclusion: "success",
    }),
  ).toThrow("release.admission.actual-otlp-evidence-missing");
});
test("bounded bytes reject Proxy before traps and reject excessive depth", () => {
  let traps = 0;
  const hostile = new Proxy(Buffer.from("{}"), {
    get() {
      traps++;
      throw new Error("caller");
    },
  });
  expect(() => parseAdmissionDocument(hostile)).toThrow();
  expect(traps).toBe(0);
  expect(() =>
    parseAdmissionDocument(Buffer.from("[".repeat(18) + "0" + "]".repeat(18))),
  ).toThrow();
});
