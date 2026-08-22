export { localSqliteReporterPackageId } from "./reporter/index.js";
export { localSqliteRetrieverPackageId } from "./retriever/index.js";
export {
  LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
  LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST,
} from "./native-support.js";
export {
  LOCAL_SQLITE_DESTINATION_TYPE,
  LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION,
  localSqliteLifecycleDeclaration,
} from "./lifecycle/capability.js";
export { createLocalSqliteLifecycleHandler } from "./lifecycle/configuration.js";

export const localSqliteDestinationPackageId =
  "@agentscope/destination-local-sqlite" as const;
