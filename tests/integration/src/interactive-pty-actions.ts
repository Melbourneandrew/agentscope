import { createHash } from "node:crypto";

import { deepFreeze } from "./canonical.js";

type InteractivePtyScenario = Readonly<{
  executionMode: string;
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
  if (
    scenario.executionMode !== "interactive" ||
    scenario.outputContract !== "semantic-pty" ||
    input.byteLength !==
      Buffer.from(scenario.terminalInputBase64, "base64").byteLength
  )
    throw new Error("integration.manifest.interaction");
  const initialInputBytes =
    input.byteLength - scenario.postCompletionInputByteLength;
  const inputAction = (start: number, byteLength: number) => ({
    action: "input" as const,
    byteLength,
    inputSha256: createHash("sha256")
      .update(input.subarray(start, start + byteLength))
      .digest("hex"),
  });
  const postCompletionInputActions = Array.from(
    { length: scenario.postCompletionInputByteLength },
    (_, offset) => inputAction(initialInputBytes + offset, 1),
  );
  return deepFreeze([
    { action: "resize" as const, geometry: { columns: 100, rows: 30 } },
    inputAction(0, initialInputBytes),
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
