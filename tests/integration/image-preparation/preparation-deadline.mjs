/** Timing projection for the existing preparation policy, never a new owner. */
import { performance } from "node:perf_hooks";

export const selectPreparationDeadline = (options, limits) => {
  const enteredAt = performance.now();
  const requested = options.maximumPreparationMilliseconds ?? limits.maximum;
  const teardown = options.teardownMilliseconds ?? limits.teardown;
  const inherited = options.deadline;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 4 ||
    requested > limits.maximum ||
    !Number.isSafeInteger(teardown) ||
    teardown < 1 ||
    teardown > limits.teardown ||
    requested <= teardown * 3 ||
    (inherited !== undefined && !Number.isFinite(inherited))
  )
    throw new Error("integration.images.deadline");
  const deadline = Math.min(enteredAt + requested, inherited ?? Infinity);
  const effective =
    inherited === undefined
      ? requested
      : Math.min(requested, Math.floor(deadline - enteredAt));
  // An earlier boundary cannot borrow from either existing terminal reserve.
  if (effective <= teardown * 3) throw new Error("integration.images.deadline");
  return Object.freeze({
    deadline,
    workDeadline: deadline - teardown,
    reconciliationDeadline: deadline - Math.floor(teardown / 2),
    maximumPreparationMilliseconds: effective,
    teardownMilliseconds: teardown,
  });
};
