import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
import {
  createHookEntryAuthority,
  createOwnedHookEntryAuthorityForCli,
} from "@agentscope/core/hook-orchestration";
import { afterEach, describe, expect, it } from "vitest";

import {
  runProductCodexHookEvidence,
  runProductCodexHookEvidenceForTesting,
} from "./hook-production.js";
import { createProductionCliServices } from "./production-services.js";

const roots: string[] = [];
const presentPlan = (): Promise<void> => Promise.resolve();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const hook = (event: "SessionStart" | "Stop" | "SessionEnd") =>
  new TextEncoder().encode(
    JSON.stringify(
      event === "SessionStart"
        ? {
            cwd: "/untrusted/workspace",
            hook_event_name: event,
            model: "fixture-model",
            permission_mode: "default",
            session_id: "session-1",
            source: "startup",
            transcript_path: null,
          }
        : event === "Stop"
          ? {
              cwd: "/untrusted/workspace",
              hook_event_name: event,
              last_assistant_message: "must-not-reach-transport",
              model: "fixture-model",
              permission_mode: "default",
              session_id: "session-1",
              stop_hook_active: false,
              transcript_path: null,
              turn_id: "turn-1",
            }
          : {
              cwd: "/untrusted/workspace",
              hook_event_name: event,
              reason: "other",
              session_id: "session-1",
              transcript_path: null,
            },
    ),
  );

describe("production Codex hook composition", () => {
  it("keeps the production entrypoint inert for non-Stop lifecycle hooks", async () => {
    await expect(
      runProductCodexHookEvidence({
        evidence: hook("SessionStart"),
        hookEntryAuthority: createHookEntryAuthority({
          durationMilliseconds: 2_000,
          startedAt: performance.now(),
        }),
        launcher: {
          harnessType: "@agentscope/harness-codex",
          homeRoot: "/unneeded-for-non-stop",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("routes one untouched Stop hook through Core and the selected Reporter", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentscope-hook-production-"));
    roots.push(root);
    const environment = {
      LANGFUSE_PUBLIC_KEY: "public-canary",
      LANGFUSE_SECRET_KEY: "secret-canary",
    };
    const homeResolver = createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: root },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    });
    const services = createProductionCliServices({
      environment,
      homeResolver,
      workspace: root,
    });
    await services.init({ apply: true, presentPlan });
    const configured = await services.configureDestination({
      credentialEnvironment: [
        "public-key=LANGFUSE_PUBLIC_KEY",
        "secret-key=LANGFUSE_SECRET_KEY",
      ],
      name: "langfuse",
      settingsJson: JSON.stringify({
        allowInsecureLoopback: true,
        endpoint: "http://127.0.0.1:4318",
      }),
      type: "langfuse",
    });
    expect(configured.status).toBe("success");
    expect((await services.setRouting({ names: ["langfuse"] })).status).toBe(
      "success",
    );
    const requests: Array<Readonly<{ body?: Uint8Array; method: string }>> = [];
    const authority = createOwnedHookEntryAuthorityForCli({
      durationMilliseconds: 2_500,
      homeRoot: root,
      platform: process.platform,
      startedAt: performance.now(),
    });
    await runProductCodexHookEvidenceForTesting(
      {
        evidence: hook("Stop"),
        hookEntryAuthority: authority,
        launcher: {
          harnessType: "@agentscope/harness-codex",
          homeRoot: root,
        },
      },
      {
        environment,
        transportExecutor: (request) => {
          requests.push(request);
          return Promise.resolve({
            status: 200,
            headers: {},
            body: new Uint8Array(),
          });
        },
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body?.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(requests[0]?.body)).not.toContain(
      "must-not-reach-transport",
    );
  });

  it.each(["SessionStart", "SessionEnd"] as const)(
    "validates %s without fabricating a trace",
    async (event) => {
      let requests = 0;
      await runProductCodexHookEvidenceForTesting(
        {
          evidence: hook(event),
          hookEntryAuthority: createHookEntryAuthority({
            durationMilliseconds: 2_000,
            startedAt: performance.now(),
          }),
          launcher: {
            harnessType: "@agentscope/harness-codex",
            homeRoot: "/unneeded-for-non-stop",
          },
        },
        {
          environment: {},
          transportExecutor: () => {
            requests += 1;
            return Promise.reject(new Error("unexpected"));
          },
        },
      );
      expect(requests).toBe(0);
    },
  );
});

describe("production Codex hook home authority", () => {
  it("rejects a launcher root substituted after the owned-home transfer", async () => {
    let requests = 0;
    await expect(
      runProductCodexHookEvidenceForTesting(
        {
          evidence: hook("Stop"),
          hookEntryAuthority: createOwnedHookEntryAuthorityForCli({
            durationMilliseconds: 2_000,
            homeRoot: "/authenticated/agentscope-home",
            platform: process.platform,
            startedAt: performance.now(),
          }),
          launcher: {
            harnessType: "@agentscope/harness-codex",
            homeRoot: "/substituted/agentscope-home",
          },
        },
        {
          environment: {},
          transportExecutor: () => {
            requests += 1;
            return Promise.reject(new Error("unexpected"));
          },
        },
      ),
    ).rejects.toThrow("cli.hook.invalid");
    expect(requests).toBe(0);
  });
});
