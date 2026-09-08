import type {
  HeadlessCanonicalTraceEnvelope,
  HeadlessExecutionRequest,
  HeadlessExecutionTrace,
  HeadlessObserverScenario,
} from "./headless-supervisor-contract.js";
import {
  HeadlessSupervisorError,
  type HeadlessSupervisorCapability,
  type HeadlessSupervisorExecutionOptions,
} from "./headless-supervisor.js";
import {
  executeWithHeadlessSupervisorCapability,
  executeSelectedPtyProcessWithCapability,
  executeSelectedHeadlessProcessWithCapability,
  readHeadlessSupervisorKernelErrorCode,
} from "./internal/headless-supervisor-backend.js";
import type {
  SelectedPtyExecutionReceipt,
  SelectedPtyExecutionRequest,
} from "./pty-terminal-contract.js";

/**
 * Executes one family-owned non-PTY scenario through the package-authenticated
 * selected isolation backend and returns its canonical protocol envelope. This
 * consumer cannot mint backend authority and accepts no caller-supplied backend
 * callback. Synthetic component-fixture evidence is not accepted here.
 */
export const executeBoundedHeadlessSupervisor = async (
  capability: HeadlessSupervisorCapability,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  options: HeadlessSupervisorExecutionOptions = {},
): Promise<HeadlessCanonicalTraceEnvelope> => {
  try {
    return await executeWithHeadlessSupervisorCapability(
      capability,
      scenario,
      request,
      options,
    );
  } catch (error: unknown) {
    throw new HeadlessSupervisorError(
      readHeadlessSupervisorKernelErrorCode(error) ??
        "testkit.headless.kernel.failure",
    );
  }
};

/**
 * Executes a production request through a capability that was already selected
 * by the trusted isolation runner. The caller can consume but cannot mint that
 * capability or substitute backend operations.
 */
export const executeSelectedHeadlessProcess = async (
  capability: HeadlessSupervisorCapability,
  request: HeadlessExecutionRequest,
  options: HeadlessSupervisorExecutionOptions = {},
): Promise<HeadlessExecutionTrace> => {
  try {
    return await executeSelectedHeadlessProcessWithCapability(
      capability,
      request,
      options,
    );
  } catch (error: unknown) {
    throw new HeadlessSupervisorError(
      readHeadlessSupervisorKernelErrorCode(error) ??
        "testkit.headless.kernel.failure",
    );
  }
};

/**
 * Executes one PTY request through the same capability and selected isolation
 * backend as headless execution. The caller cannot supply or mint transport or
 * process authority.
 */
export const executeSelectedPtyProcess = async (
  capability: HeadlessSupervisorCapability,
  request: SelectedPtyExecutionRequest,
  options: HeadlessSupervisorExecutionOptions = {},
): Promise<SelectedPtyExecutionReceipt> => {
  try {
    return await executeSelectedPtyProcessWithCapability(
      capability,
      request,
      options,
    );
  } catch (error: unknown) {
    throw new HeadlessSupervisorError(
      readHeadlessSupervisorKernelErrorCode(error) ??
        "testkit.headless.kernel.failure",
    );
  }
};
