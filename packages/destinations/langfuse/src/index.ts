export {
  langfuseDestinationDescriptor,
  langfuseReporterPackageId,
} from "./reporter/index.js";
export type { LangfuseDestinationSettings } from "./compatibility.js";
export { langfuseRetrieverPackageId } from "./retriever/identity.js";
export { LANGFUSE_COMPATIBILITY_MANIFEST } from "./compatibility.js";

export const langfuseDestinationPackageId =
  "@agentscope/destination-langfuse" as const;
