export interface ImagePreparationDockerState {
  admitClient(client: object): void;
  admitPreparedSet(prepared: object): void;
  clientIsUsable(client: object): boolean;
  hasDiagnostic(client: object): boolean;
  markUncertain(client: object): void;
  pendingCount(client: object): number;
  readDiagnostic(client: object): unknown;
  recordDiagnostic(client: object, diagnostic: unknown): void;
  recordPendingImage(client: object, tag: string, imageId: string): void;
}

export interface ImagePreparationEvidenceState {
  hasPreparedSet(prepared: object): boolean;
}

export interface ImagePreparationRetirementState {
  beginClose(client: object): void;
  clientIsClosing(client: object): boolean;
  clientIsUncertain(client: object): boolean;
  completePendingImage(client: object, tag: string): void;
  endClose(client: object): void;
  finishClose(client: object): void;
  hasClient(client: object): boolean;
  hasDiagnostic(client: object): boolean;
  markUncertain(client: object): void;
  pendingCount(client: object): number;
  pendingImageId(client: object, tag: string): string | undefined;
  recordDiagnostic(client: object, diagnostic: unknown): void;
}

export interface ImagePreparationState {
  readonly docker: Readonly<ImagePreparationDockerState>;
  readonly evidence: Readonly<ImagePreparationEvidenceState>;
  readonly retirement: Readonly<ImagePreparationRetirementState>;
}

export declare const createImagePreparationState: () => Readonly<ImagePreparationState>;
