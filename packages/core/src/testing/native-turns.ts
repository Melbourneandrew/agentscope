import { claude, codex, cursor } from "../native-turns/index.js";
import type { NativeTurnTraceResult } from "../native-turns/index.js";
import {
  createNativeTurnFixtureWorkspace,
  type NativeTurnFixtureProvider,
} from "./fixtures.js";

export async function buildNativeTurnFixtureTrace(
  provider: NativeTurnFixtureProvider,
): Promise<NativeTurnTraceResult> {
  const workspace = createNativeTurnFixtureWorkspace(provider);
  try {
    if (provider === "cursor") {
      return await cursor.buildNativeTurnTrace(
        {
          sessionId: "cursor-session",
          turnId: "cursor-hook-generation-id",
          sourcePath: workspace.sourcePath,
        },
        {
          adapterOptions: workspace.adapterOptions,
        },
      );
    }
    if (provider === "codex") {
      return await codex.buildNativeTurnTrace(
        {
          sessionId: "codex-thread-id",
          turnId: "turn-id-1",
          transcriptTurnId: "turn-id-1",
          sourcePath: workspace.sourcePath,
        },
        {
          adapterOptions: workspace.adapterOptions,
        },
      );
    }
    return await claude.buildNativeTurnTrace(
      {
        sessionId: "claude-session-id",
        sourcePath: workspace.sourcePath,
      },
      {
        adapterOptions: workspace.adapterOptions,
      },
    );
  } finally {
    workspace.cleanup();
  }
}
