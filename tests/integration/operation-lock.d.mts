export interface IntegrationOperationLockOptions {
  maximumWaitMilliseconds?: number;
}

export type ReleaseIntegrationOperationLock = () => Promise<void>;

export declare const acquireIntegrationOperationLock: (
  workspaceRoot: string,
  errorCode: string,
  options?: IntegrationOperationLockOptions,
) => Promise<ReleaseIntegrationOperationLock>;
