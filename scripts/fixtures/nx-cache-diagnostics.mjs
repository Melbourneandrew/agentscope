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
