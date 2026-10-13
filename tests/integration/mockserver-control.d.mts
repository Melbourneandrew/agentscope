export interface MockServerControlMaterial {
  readonly privateKey: Buffer;
  readonly jwks: Buffer;
}
export function readMockServerBootClock(): number;
export interface MockServerControlResponse {
  readonly status: number;
  readonly bytes: Buffer;
}
export interface MockServerControl {
  send(
    method: string,
    path: string,
    value?: unknown,
    authentication?: string,
    upgrade?: boolean,
  ): Promise<MockServerControlResponse>;
  configure(
    expectations: unknown,
    cutoff?: number,
  ): Promise<MockServerControlResponse>;
  requests(): Promise<MockServerControlResponse>;
  stop(): Promise<MockServerControlResponse>;
  snapshot(): Readonly<MockServerTrafficSnapshot>;
}
export interface MockServerTrafficObservation {
  readonly method: string;
  readonly path: string;
  readonly role:
    "allowed" | "forbidden" | "unauthenticated" | "readiness" | "data-plane";
  readonly status: number;
  readonly bodyBytes: number;
  readonly bodySha256: string;
}
export interface MockServerTrafficSnapshot {
  readonly runId: string;
  readonly entries: readonly MockServerTrafficObservation[];
}
export function mockServerTrafficRow(
  method: string,
  path: string,
  role: MockServerTrafficObservation["role"],
  status: number,
  body?: string | Buffer,
): Readonly<MockServerTrafficObservation>;
export function observeMockServerCandidateTraffic(input: {
  runId: string;
  modelRequestCount: number;
  deadline: number;
}): Promise<readonly MockServerTrafficObservation[]>;
export interface MockServerRequestObservation {
  readonly method: string;
  readonly path: string;
  readonly bodyBytes: number;
  readonly bodySha256: string;
  readonly modelSha256: string | null;
  readonly promptOccurrenceCount: number;
  readonly credentialHeaderCount: number;
  readonly role?: MockServerTrafficObservation["role"];
  readonly status?: number;
}
export function snapshotMockServerTraffic(
  value: unknown,
  runId: string,
): Readonly<MockServerTrafficSnapshot>;
export function probeMockServerCandidate(input: {
  runId: string;
  host: string;
  deadline: number;
  now: () => number;
}): Promise<Readonly<MockServerTrafficSnapshot>>;
export function createMockServerControlMaterial(
  runId: string,
): Readonly<MockServerControlMaterial>;
export function openMockServerControl(input: {
  runId: string;
  host: string;
  deadline: number;
  now: () => number;
  material?: unknown;
}): Readonly<MockServerControl>;
export function verifyMockServerControlBoundary(control: {
  send(
    method: string,
    path: string,
    value?: unknown,
    authentication?: string,
    upgrade?: boolean,
  ): Promise<Pick<MockServerControlResponse, "status">>;
}): Promise<void>;
export function projectMockServerRequests(
  bytes: Buffer,
  promptSha256?: string,
): readonly MockServerRequestObservation[];
export function readMockServerFinalLedger(input: {
  directory: string;
  deadline: number;
  now: () => number;
}): Buffer;
export function assertMockServerFinalLedger(
  ledger: readonly MockServerRequestObservation[],
  fixture: {
    modelLedger?: {
      entries: readonly Pick<
        MockServerRequestObservation,
        "method" | "path" | "bodyBytes"
      >[];
    };
    harnessObservation?: { modelRequestBodySha256?: string };
  },
  routeFixture: {
    routes: readonly {
      routeId: string;
      method: string;
      path: string;
      requestBody: unknown;
    }[];
  },
  scenario: { scenarioId: string; modelRoutes: readonly string[] },
  comparison: {
    readonly traffic: MockServerTrafficSnapshot;
    readonly runId: string;
  },
): void;
