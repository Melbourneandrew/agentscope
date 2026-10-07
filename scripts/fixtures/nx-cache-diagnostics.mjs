const phases = [
  "entry",
  "setup",
  "command",
  "build-1",
  "build-2",
  "build-3",
  "change",
  "cleanup",
  "complete",
];
const commandPhases = [
  "none",
  "wrapper-startup",
  "birth-inspection",
  "nx-command",
  "terminal-inspection",
  "stop-inspection",
  "join-inspection",
  "complete",
];
const elapsedLimit = 300_000;

// Fixture observations only: this object has no execution or cleanup authority.
export function createNxCacheDiagnostic(started, now) {
  let phase = "entry";
  let commandPhase = "none";
  return Object.freeze({
    phase(value) {
      phase = phases.includes(value) ? value : "unknown";
    },
    command(value) {
      commandPhase = commandPhases.includes(value) ? value : "unknown";
    },
    snapshot() {
      const elapsed = now() - started;
      const valid = Number.isFinite(elapsed) && elapsed >= 0;
      return Object.freeze({
        phase,
        commandPhase,
        originalElapsedMilliseconds: valid
          ? Math.min(elapsedLimit, Math.floor(elapsed))
          : null,
        elapsedCapped: valid && elapsed > elapsedLimit,
      });
    },
  });
}

// Observations only: original fixture deadlines remain owned by the caller.
export function createNxCacheProgressDiagnostic(
  started,
  deadline,
  suiteStarted,
  ordinal,
  { now, publish },
) {
  let observedNow;
  const diagnostic = createNxCacheDiagnostic(started, () => observedNow);
  let previous;
  let emitted = 0;
  const snapshot = () => {
    observedNow = now();
    const current = diagnostic.snapshot();
    const suiteElapsed = observedNow - suiteStarted;
    const valid = Number.isFinite(suiteElapsed) && suiteElapsed >= 0;
    const remaining = deadline - observedNow;
    return Object.freeze({
      __proto__: null,
      fixtureOrdinal:
        Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= 16
          ? ordinal
          : null,
      ...current,
      fixtureRemainingMilliseconds:
        Number.isFinite(remaining) &&
        current.originalElapsedMilliseconds !== null
          ? Math.max(0, Math.min(elapsedLimit, Math.floor(remaining)))
          : null,
      suiteObservationElapsedMilliseconds: valid
        ? Math.min(elapsedLimit, Math.floor(suiteElapsed))
        : null,
      suiteObservationElapsedCapped: valid && suiteElapsed > elapsedLimit,
    });
  };
  const emit = () => {
    const value = snapshot();
    const transition = `${value.phase}/${value.commandPhase}`;
    if (transition === previous || emitted >= 64) return;
    previous = transition;
    emitted++;
    try {
      publish(value);
    } catch {
      /* A diagnostic sink never changes fixture authority or outcome. */
    }
  };
  emit();
  return Object.freeze({
    phase(value) {
      diagnostic.phase(value);
      emit();
    },
    command(value) {
      diagnostic.command(value);
      emit();
    },
    snapshot,
  });
}
