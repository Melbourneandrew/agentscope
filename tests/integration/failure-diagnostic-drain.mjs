// Only a terminal, already-failed controller calls this. The absolute outer
// deadline, not a fresh per-write timer, bounds optional diagnostic delivery.
export const drainFailureDiagnostic = async ({
  deadlineMilliseconds,
  now,
  output,
  stream,
}) => {
  if (
    typeof output !== "string" ||
    output.length < 1 ||
    output.length > 1024 ||
    typeof now !== "function" ||
    typeof stream?.write !== "function"
  )
    return false;
  let remaining;
  try {
    remaining = Math.floor(deadlineMilliseconds - now() - 5);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(remaining) || remaining <= 0) return false;
  const budget = Math.min(100, remaining);
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (delivered) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(delivered);
    };
    const timer = setTimeout(() => settle(false), budget);
    try {
      stream.write(output, (error) =>
        settle(error === undefined || error === null),
      );
    } catch {
      settle(false);
    }
  });
};
