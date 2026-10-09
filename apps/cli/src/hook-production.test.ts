import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
import {
  createHookEntryAuthority,
  createOwnedHookEntryAuthorityForCli,
} from "@agentscope/core/hook-orchestration";
import { afterAll, describe, expect, it } from "vitest";

import {
  runProductHookEvidence,
  runProductHookEvidenceForTesting,
} from "./hook-production.js";
import { createProductionCliServices } from "./production-services.js";

const roots: string[] = [];
const presentPlan = (): Promise<void> => Promise.resolve();

// Assert actual product bytes independently of the integration observer. This
// test has no foreign build prerequisite and does not rewrite the wire graph.
const expectUnavailableHarnessVersion = (body: Uint8Array) => {
  type Attribute = { key: string; value: { stringValue?: string } };
  const batch = JSON.parse(new TextDecoder().decode(body)) as {
    resourceSpans: {
      resource: { attributes: Attribute[] };
      scopeSpans: { spans: { attributes: Attribute[] }[] }[];
    }[];
  };
  const primary = batch.resourceSpans[0]!;
  const attributes = primary.scopeSpans[0]!.spans[0]!.attributes;
  const field = "agentscope.harness.version";
  expect(attributes.some((entry) => entry.key === field)).toBe(false);
  expect(primary.resource.attributes.some((entry) => entry.key === field)).toBe(
    false,
  );
  const ledger = (key: string) => {
    const text = attributes.find((entry) => entry.key === key)?.value
      .stringValue;
    expect(text).toBeTypeOf("string");
    return (JSON.parse(text!) as { field: string }[]).filter(
      (entry) => entry.field === field,
    );
  };
  expect(ledger("agentscope.mapping.provenance")).toEqual([
    { field, source: "process" },
  ]);
  expect(ledger("agentscope.mapping.unavailable")).toEqual([
    { field, state: "unavailable", reason: "not-emitted" },
  ]);
};

afterAll(async () => {
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

const configureHookHome = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-claude-hook-"));
  roots.push(root);
  const environment = {
    LANGFUSE_PUBLIC_KEY: "public-canary",
    LANGFUSE_SECRET_KEY: "secret-canary",
  };
  const services = createProductionCliServices({
    environment,
    homeResolver: createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: root },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    }),
    workspace: root,
  });
  await services.init({ apply: true, presentPlan });
  expect(
    (
      await services.configureDestination({
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
      })
    ).status,
  ).toBe("success");
  expect((await services.setRouting({ names: ["langfuse"] })).status).toBe(
    "success",
  );
  return { root, environment };
};

// One production process owns one home authority; event cases reuse that home.
let configuredHome: ReturnType<typeof configureHookHome> | undefined;
const configuredHookHome = () => (configuredHome ??= configureHookHome());

describe("production Codex hook composition", () => {
  it("keeps the production entrypoint inert for non-Stop lifecycle hooks", async () => {
    await expect(
      runProductHookEvidence({
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
    const { root, environment } = await configuredHookHome();
    const requests: Array<Readonly<{ body?: Uint8Array; method: string }>> = [];
    const authority = createOwnedHookEntryAuthorityForCli({
      durationMilliseconds: 5_000,
      homeRoot: root,
      platform: process.platform,
      startedAt: performance.now(),
    });
    await runProductHookEvidenceForTesting(
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
    expectUnavailableHarnessVersion(requests[0]!.body!);
  });

  it.each(["SessionStart", "SessionEnd"] as const)(
    "validates %s without fabricating a trace",
    async (event) => {
      let requests = 0;
      await runProductHookEvidenceForTesting(
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
      runProductHookEvidenceForTesting(
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

describe("production Claude hook composition", () => {
  it.each(["SessionStart", "PreToolUse", "PostToolUse", "Stop"])(
    "routes the governed %s observation through the existing Core lifecycle",
    async (event) => {
      const { root, environment } = await configuredHookHome();
      const evidence = new TextEncoder().encode(
        JSON.stringify({
          cwd: root,
          hook_event_name: event,
          session_id: "claude-session",
          transcript_path: "/never-read.jsonl",
          ...(event === "SessionStart"
            ? { source: "startup", model: "unattributed-native-model" }
            : event === "Stop"
              ? { stop_hook_active: false, last_assistant_message: "canary" }
              : {
                  tool_name: "Read",
                  tool_use_id: "tool-1",
                  tool_input: { path: "input-canary" },
                  ...(event === "PostToolUse"
                    ? { tool_response: { content: "output-canary" } }
                    : {}),
                }),
        }),
      );
      const bodies: Uint8Array[] = [];
      await runProductHookEvidenceForTesting(
        {
          evidence,
          hookEntryAuthority: createOwnedHookEntryAuthorityForCli({
            durationMilliseconds: 5_000,
            homeRoot: root,
            platform: process.platform,
            startedAt: performance.now(),
          }),
          launcher: {
            harnessType: "@agentscope/harness-claude-code",
            homeRoot: root,
          },
        },
        {
          environment,
          transportExecutor: (request) => {
            if (request.body) bodies.push(request.body);
            return Promise.resolve({
              status: 200,
              headers: {},
              body: new Uint8Array(),
            });
          },
        },
      );
      expect(bodies).toHaveLength(1);
      expectUnavailableHarnessVersion(bodies[0]!);
      const wire = new TextDecoder().decode(bodies[0]);
      expect(wire).toContain("claude-code");
      if (event === "SessionStart") {
        expect(wire).toContain("claude.SessionStart");
      } else {
        expect(wire).toContain("claude.hook-invocation");
        if (event === "Stop") expect(wire).toContain("claude.Stop");
        else {
          expect(wire).toContain("tool.name");
          expect(wire).toContain("Read");
          expect(wire).toContain("tool.id");
          expect(wire).toContain("tool-1");
        }
      }
      expect(wire).not.toContain("unattributed-native-model");
      expect(wire).not.toContain("never-read.jsonl");
    },
  );

  it.each(["@agentscope/harness-unknown", "@agentscope/harness-claude-code"])(
    "rejects an unknown identity or unowned SessionEnd before Core work (%s)",
    async (harnessType) => {
      let requests = 0;
      await expect(
        runProductHookEvidenceForTesting(
          {
            evidence: new TextEncoder().encode(
              JSON.stringify({
                cwd: "/workspace",
                hook_event_name: "SessionEnd",
                session_id: "session",
                transcript_path: "/unused",
                reason: "other",
              }),
            ),
            hookEntryAuthority: createHookEntryAuthority({
              durationMilliseconds: 2_000,
              startedAt: performance.now(),
            }),
            launcher: { harnessType, homeRoot: "/must-not-open" },
          },
          {
            environment: {},
            transportExecutor: () => {
              requests += 1;
              return Promise.reject(new Error("must-not-run"));
            },
          },
        ),
      ).rejects.toThrow("cli.hook.invalid");
      expect(requests).toBe(0);
    },
  );
});
