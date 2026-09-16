import { createHash } from "node:crypto";

import { deepFreeze } from "./canonical.js";

type InteractivePtyScenario = Readonly<{
  executionMode: string;
  nativeReadiness: Readonly<{ kind: string }> | null;
  outputContract: string;
  postCompletionControl: string;
  postCompletionInputByteLength: number;
  terminalInputBase64: string;
  waitForSemanticCompletionBeforeTerminalAction: boolean;
}>;

export const compileInteractivePtyActions = (
  scenario: InteractivePtyScenario,
  input: Uint8Array,
) => {
  const staticInput = Buffer.from(scenario.terminalInputBase64, "base64");
  const challengeBytes =
    scenario.nativeReadiness?.kind === "challenge-marker" ? 65 : 0;
  const checkpointBytes = challengeBytes === 65 ? 1 : 0;
  if (
    scenario.executionMode !== "interactive" ||
    scenario.outputContract !== "semantic-pty" ||
    input.byteLength !==
      staticInput.byteLength + challengeBytes + checkpointBytes ||
    (challengeBytes === 65 &&
      (!/^[a-f0-9]{64}$/u.test(Buffer.from(input.subarray(0, 64)).toString()) ||
        input[64] !== 0x0a ||
        input[65] !== 0x0a)) ||
    !Buffer.from(input.subarray(challengeBytes + checkpointBytes)).equals(
      staticInput,
    )
  )
    throw new Error("integration.manifest.interaction");
  const initialInputBytes =
    challengeBytes > 0
      ? challengeBytes
      : input.byteLength - scenario.postCompletionInputByteLength;
  const postCompletionInputStart = initialInputBytes + checkpointBytes;
  const inputAction = (start: number, byteLength: number) => ({
    action: "input" as const,
    byteLength,
    inputSha256: createHash("sha256")
      .update(input.subarray(start, start + byteLength))
      .digest("hex"),
  });
  const postCompletionInputActions = Array.from(
    { length: scenario.postCompletionInputByteLength },
    (_, offset) => inputAction(postCompletionInputStart + offset, 1),
  );
  return deepFreeze([
    { action: "resize" as const, geometry: { columns: 100, rows: 30 } },
    ...(initialInputBytes > 0 ? [inputAction(0, initialInputBytes)] : []),
    ...(checkpointBytes === 1
      ? [
          {
            action: "checkpoint-process-topology" as const,
            topology: "root-direct-child-direct-grandchild" as const,
            byteLength: 1 as const,
            inputSha256: createHash("sha256")
              .update(input.subarray(initialInputBytes, initialInputBytes + 1))
              .digest("hex"),
          },
        ]
      : []),
    ...(scenario.waitForSemanticCompletionBeforeTerminalAction
      ? [
          { action: "wait-for-semantic-completion" as const },
          ...postCompletionInputActions,
          ...(scenario.postCompletionControl === "interrupt-byte"
            ? [
                {
                  action: "interrupt-byte" as const,
                  byte: 3 as const,
                },
              ]
            : []),
        ]
      : [{ action: "eof" as const }]),
  ]);
};
