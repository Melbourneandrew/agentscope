import type {
  HeadlessCanonicalTraceEnvelope,
  HeadlessExecutionRequest,
  HeadlessObserverScenario,
} from "./headless-supervisor-contract.js";
import {
  HeadlessSupervisorError,
  type HeadlessSupervisorCapability,
  type HeadlessSupervisorExecutionOptions,
} from "./headless-supervisor.js";
import { executeWithHeadlessSupervisorCapability } from "./internal/headless-supervisor-backend.js";

/**
 * Executes one family-owned non-PTY scenario through a package-authenticated
 * backend and returns its canonical protocol envelope. This consumer cannot
 * mint backend authority and accepts no caller-supplied backend callback.
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
      options.signal,
    );
  } catch (error: unknown) {
    throw error instanceof HeadlessSupervisorError
      ? error
      : new HeadlessSupervisorError("testkit.headless.kernel.failure");
  }
};
