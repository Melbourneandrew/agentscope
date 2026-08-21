export { localSqliteReporterPackageId } from "./reporter/index.js";
export { localSqliteRetrieverPackageId } from "./retriever/index.js";
export {
  inspectLocalSqliteNativeSupport,
  LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
  type LocalSqliteNativeSupportResult,
  type LocalSqliteRuntimeIdentity,
} from "./native-support.js";
export {
  LOCAL_SQLITE_DESTINATION_TYPE,
  LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION,
  localSqliteLifecycleDeclaration,
} from "./lifecycle/capability.js";

export const localSqliteDestinationPackageId =
  "@agentscope/destination-local-sqlite" as const;
