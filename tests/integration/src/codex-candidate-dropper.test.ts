import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../codex-candidate-dropper.mjs");

describe("Codex candidate principal dropper", () => {
  it("binds only fixed synthetic credential refs and the readonly public CA", () => {
    const source = readFileSync(helper, "utf8");
    const start = source.indexOf("const fail =");
    const end = source.indexOf("process.setgroups([])", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const env = {
      AGENTSCOPE_CANDIDATE_RUN_ID: "0123456789abcdef",
      AGENTSCOPE_HOME: "/agentscope-home",
      AGENTSCOPE_LANGFUSE_PUBLIC_KEY: "DUMMY_PUBLIC_KEY",
      AGENTSCOPE_LANGFUSE_SECRET_KEY: "DUMMY_SECRET_KEY",
      CODEX_HOME: "/harness-home/codex",
      HOME: "/harness-home",
      LANG: "C.UTF-8",
      NODE_EXTRA_CA_CERTS: "/opt/agentscope/collector-ca.pem",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      RUST_LOG: "codex_hooks::engine::command_runner=trace",
      TERM: "xterm-256color",
      XDG_CONFIG_HOME: "/harness-home",
    };
    const execute = (selected: Record<string, string>) => {
      runInNewContext(source.slice(start, end), {
        process: {
          argv: ["node", helper],
          platform: "linux",
          execve: () => undefined,
          getuid: () => 0,
          geteuid: () => 0,
          getgid: () => 0,
          getegid: () => 0,
          ppid: 2,
          env: selected,
        },
      });
    };
    expect(() => {
      execute(env);
    }).not.toThrow();
    for (const key of [
      "AGENTSCOPE_LANGFUSE_PUBLIC_KEY",
      "AGENTSCOPE_LANGFUSE_SECRET_KEY",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(() => {
        execute({ ...env, [key]: "substituted" });
      }).toThrow("integration.codex.candidate-principal");
      const missing: Record<string, string> = { ...env };
      delete missing[key];
      expect(() => {
        execute(missing);
      }).toThrow("integration.codex.candidate-principal");
    }
    expect(() => {
      execute({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    }).toThrow("integration.codex.candidate-principal");
  });
  it("rejects any caller-selected command or argument", () => {
    const result = spawnSync(process.execPath, [helper, "--forbidden"], {
      env: { LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeout: 2_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "integration.codex.candidate-principal",
    );
  });

  it.skipIf(process.platform === "linux" && process.getuid?.() === 0)(
    "rejects an unprivileged controller before any candidate exec",
    () => {
      const result = spawnSync(process.execPath, [helper], {
        env: { LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: 2_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "integration.codex.candidate-principal",
      );
    },
  );
});
