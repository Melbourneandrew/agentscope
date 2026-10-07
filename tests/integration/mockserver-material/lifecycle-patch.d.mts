export type LifecycleSourceName =
  | "eventLog"
  | "httpState"
  | "persistence"
  | "lifeCycle"
  | "jsonBody"
  | "requestHandler";
export const lifecycleSourcePins: readonly Readonly<{
  name: LifecycleSourceName;
  path: string;
  bytes: number;
  sha256: string;
}>[];
export function patchMockServerLifecycleSource(
  name: string,
  input: Uint8Array,
): string;
