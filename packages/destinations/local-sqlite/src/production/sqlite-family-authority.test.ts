import { describe, expect, it } from "vitest";

import type { OwnedSqliteFamilyEvidence } from "./owned-filesystem.js";
import {
  admitsOwnedSqliteFamilyExpansion,
  admitsOwnedSqliteFamilySettlement,
} from "./sqlite-family-authority.js";

const entry = (
  name: string,
  physicalIdentity: string,
): OwnedSqliteFamilyEvidence =>
  Object.freeze({
    name,
    evidence: Object.freeze({ bytes: 1, physicalIdentity, sparse: false }),
  });

const main = entry("traces.sqlite", "dev:1:ino:1");
const shared = entry("traces.sqlite-shm", "dev:1:ino:2");
const log = entry("traces.sqlite-wal", "dev:1:ino:3");

describe("SQLite family transition authority", () => {
  it("admits only exact monotonic SQLite sidecar creation during native work", () => {
    expect(admitsOwnedSqliteFamilyExpansion([main], [main, shared, log])).toBe(
      true,
    );
    expect(
      admitsOwnedSqliteFamilyExpansion(
        [main, shared],
        [main, entry(shared.name, "dev:1:ino:9"), log],
      ),
    ).toBe(false);
    expect(admitsOwnedSqliteFamilyExpansion([main, shared], [main])).toBe(
      false,
    );
    expect(
      admitsOwnedSqliteFamilyExpansion(
        [main],
        [main, entry("traces.sqlite-journal", "dev:1:ino:4")],
      ),
    ).toBe(false);
    expect(admitsOwnedSqliteFamilyExpansion([], [main])).toBe(false);
    expect(admitsOwnedSqliteFamilyExpansion([main], [main, main])).toBe(false);
    expect(
      admitsOwnedSqliteFamilyExpansion([shared, main], [main, shared]),
    ).toBe(false);
  });

  it("admits close-time sidecar disappearance but no new or changed inode", () => {
    expect(admitsOwnedSqliteFamilySettlement([main, shared, log], [main])).toBe(
      true,
    );
    expect(
      admitsOwnedSqliteFamilySettlement([main, shared, log], [main, log]),
    ).toBe(true);
    expect(
      admitsOwnedSqliteFamilySettlement(
        [main, shared, log],
        [entry(main.name, "dev:1:ino:8")],
      ),
    ).toBe(false);
    expect(admitsOwnedSqliteFamilySettlement([main], [main, shared])).toBe(
      false,
    );
    expect(admitsOwnedSqliteFamilySettlement([], [main])).toBe(false);
    expect(admitsOwnedSqliteFamilySettlement([main], [])).toBe(false);
  });
});
