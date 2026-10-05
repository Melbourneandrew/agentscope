/** Closed recipe data only. No process, signature or service authority. */
export const supplierMavenSettings: string;
export const supplierGlobalMavenSettings: string;
export const mockServerSupplierLayout: Readonly<{
  source: string;
  reactor: string;
  frontend: string;
  frontendNode: string;
  frontendNpm: string;
  callback: string;
  executable: string;
  bootstrapNode: string;
  artifact: string;
}>;
export function mockServerSupplierBuildPlan(
  phase: "dependency-research" | "offline-build",
): Readonly<{
  evidenceScope: "dependency-research-plan" | "offline-build-plan";
  runNetwork: "default" | "none";
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
}>;
