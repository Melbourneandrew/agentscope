const launcherName =
  /(?:^|\/)agentscope-hook-v1-[a-f0-9]{64}-d(5[0-9]|[6-9][0-9]|[1-9][0-9]{2,3}|[1-5][0-9]{4}|60000)$/u;

export const parseHookLauncherDuration = (
  value: string,
): number | undefined => {
  const match = launcherName.exec(value);
  if (!match) return undefined;
  const duration = Number(match[1]);
  return Number.isSafeInteger(duration) ? duration : undefined;
};
