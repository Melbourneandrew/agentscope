export {
  langfuseDestinationDescriptor,
  langfuseReporterPackageId,
  type LangfuseDestinationSettings,
} from "./reporter/index.js";
export { langfuseRetrieverPackageId } from "./retriever/index.js";
export { LANGFUSE_COMPATIBILITY_MANIFEST } from "./compatibility.js";

export const langfuseDestinationPackageId =
  "@agentscope/destination-langfuse" as const;
