import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateLocalSqliteAlphaProfile } from "../local-sqlite-alpha-profile.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const profile = JSON.parse(
  readFileSync(
    resolve(workspaceRoot, "release-profiles/local-sqlite-alpha-0.1.0.json"),
    "utf8",
  ),
);

describe("Local SQLite 0.1.0 experimental release profile", () => {
  it("locks the exact reduced claim and all deferred stable obligations", () => {
    expect(validateLocalSqliteAlphaProfile({ profile, workspaceRoot })).toEqual(
      {
        admission: "blocked-pending-consumed-actual-harness-evidence",
        allowed: 11,
        componentEvidence: 10,
        deferred: 12,
        stableCriteriaPreserved: 13,
      },
    );
    expect(() =>
      validateLocalSqliteAlphaProfile({
        profile,
        workspaceRoot,
        requireCertified: true,
      }),
    ).toThrow("governed actual-harness evidence is pending");
  });

  it("rejects full-support and expanded Doctor claims", () => {
    expect(() =>
      validateLocalSqliteAlphaProfile({
        workspaceRoot,
        profile: {
          ...profile,
          release: { ...profile.release, claim: "full-local-sqlite-support" },
        },
      }),
    ).toThrow("Release claim boundary drifted");
    expect(() =>
      validateLocalSqliteAlphaProfile({
        workspaceRoot,
        profile: {
          ...profile,
          doctorBoundary: { ...profile.doctorBoundary, sqliteOpen: true },
        },
      }),
    ).toThrow("Doctor claim exceeds");
  });

  it("rejects a silently removed stable obligation or criterion", () => {
    expect(() =>
      validateLocalSqliteAlphaProfile({
        workspaceRoot,
        profile: {
          ...profile,
          deferredStableObligations: profile.deferredStableObligations.slice(1),
        },
      }),
    ).toThrow("Deferred stable obligations");
    expect(() =>
      validateLocalSqliteAlphaProfile({
        workspaceRoot,
        profile: {
          ...profile,
          stableCriteriaPreserved: profile.stableCriteriaPreserved.slice(1),
        },
      }),
    ).toThrow("Stable criteria");
  });

  it("rejects duplicate consumed bundles as a completed admission", () => {
    expect(() =>
      validateLocalSqliteAlphaProfile({
        workspaceRoot,
        profile: {
          ...profile,
          admission: {
            state: "certified",
            blockingBeads: [],
            consumedEvidence: [
              "release-profiles/local-sqlite-alpha-0.1.0.json",
              "release-profiles/local-sqlite-alpha-0.1.0.json",
            ],
          },
        },
      }),
    ).toThrow("lacks both governed evidence bundles");
  });
});
