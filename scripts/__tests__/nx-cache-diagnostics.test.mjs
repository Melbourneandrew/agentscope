import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createNxCacheDiagnostic,
  createNxCacheProgressDiagnostic,
} from "../fixtures/nx-cache-diagnostics.mjs";

test.each([
  ["entry", "none", 0, 0, false],
  ["build-2", "birth-inspection", 93_242, 93_242, false],
  ["cleanup", "join-inspection", 300_001, 300_000, true],
  ["secret-path", "secret-argv", NaN, null, false],
  ["change", "terminal-inspection", -1, null, false],
])(
  "Nx diagnostic preserves only closed phases and original elapsed %s/%s",
  (phase, command, now, elapsed, capped) => {
    const diagnostic = createNxCacheDiagnostic(10, () => 10 + now);
    diagnostic.phase(phase);
    diagnostic.command(command);
    const snapshot = diagnostic.snapshot();
    assert.deepEqual(snapshot, {
      phase: phase === "secret-path" ? "unknown" : phase,
      commandPhase: command === "secret-argv" ? "unknown" : command,
      originalElapsedMilliseconds: elapsed,
      elapsedCapped: capped,
    });
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
    assert.equal(Object.isFrozen(snapshot), true);
    const observed = [];
    const progress = createNxCacheProgressDiagnostic(
      10,
      30_010,
      0,
      phase === "secret-path" ? 17 : 1,
      { now: () => 10 + now, publish: (value) => observed.push(value) },
    );
    progress.phase(phase);
    progress.command(command);
    const count = observed.length;
    progress.command(command);
    assert.equal(observed.length, count);
    assert.equal(
      progress.snapshot().fixtureOrdinal,
      phase === "secret-path" ? null : 1,
    );
    assert.equal(
      progress.snapshot().fixtureRemainingMilliseconds,
      elapsed === null ? null : Math.max(0, 30_000 - elapsed),
    );
    assert.equal(JSON.stringify(observed).includes("secret"), false);
    assert.equal(Object.isFrozen(observed[0]), true);
    assert.equal(Object.getPrototypeOf(observed[0]), null);
  },
);

test("Nx progress distinguishes cumulative settled work from unfinished delayed work", () => {
  let now = 0;
  const observed = [];
  for (let ordinal = 1; ordinal <= 16; ordinal++) {
    const diagnostic = createNxCacheProgressDiagnostic(
      now,
      now + 30_000,
      0,
      ordinal,
      {
        now: () => now,
        publish: (value) => {
          observed.push(value);
          throw new Error("private sink");
        },
      },
    );
    diagnostic.phase("complete");
    now += 20_000;
  }
  assert.equal(observed.at(-1).phase, "complete");
  assert.equal(observed.at(-1).suiteObservationElapsedMilliseconds, 300_000);
  const pending = createNxCacheProgressDiagnostic(now, now + 30_000, 0, 1, {
    now: () => now,
    publish: (value) => observed.push(value),
  });
  pending.phase("build-1");
  pending.command("nx-command");
  now += 93_242; // A clock jump observes delay; it does not assert its cause.
  pending.command("join-inspection");
  assert.equal(observed.at(-1).phase, "build-1");
  assert.equal(observed.at(-1).fixtureRemainingMilliseconds, 0);
  assert.equal(observed.at(-1).originalElapsedMilliseconds, 93_242);
  assert.equal(observed.at(-1).suiteObservationElapsedCapped, true);
  for (let index = 0; index < 100; index++)
    pending.command(index % 2 ? "complete" : "join-inspection");
  assert.ok(observed.length <= 32 + 64);
});
