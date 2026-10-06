export const inspectionFailureStages = Object.freeze([
  "birth-probe-exit",
  "birth-probe-parse",
  "deadline-after",
  "deadline-before",
  "group-existence",
  "leader-existence",
  "observation-shape",
  "unknown",
]);

export function inspectionFailure(stage) {
  const error = new Error("process inspection failed");
  Object.defineProperty(error, "inspectionStage", { value: stage });
  return error;
}

export function inspectionStage(error) {
  try {
    if (
      (typeof error !== "object" && typeof error !== "function") ||
      error === null
    )
      return "unknown";
    const descriptor = Object.getOwnPropertyDescriptor(
      error,
      "inspectionStage",
    );
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !inspectionFailureStages.includes(descriptor.value)
    )
      return "unknown";
    return descriptor.value;
  } catch {
    return "unknown";
  }
}

export function lifecycleFailure(reason) {
  return new Error(`workspace-policy child containment failed: ${reason}`);
}
