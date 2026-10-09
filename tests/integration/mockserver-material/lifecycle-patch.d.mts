export type LifecycleSourceName =
  | "eventLog"
  | "httpState"
  | "persistence"
  | "lifeCycle"
  | "jsonBody"
  | "requestHandler"
  | "actionHandler"
  | "logger";
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
export const supplierCheckstyleRules: readonly string[];
export function supplierSourceUnit(file: string): number;
export function firstSupplierCheckstyleObservation(
  text: string,
): readonly [number, number, number, number];
