import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dockerPath = "/usr/bin/docker";
const dockerSocket = "/var/run/docker.sock";
const repositoryPath = "/home/runner/work/agentscope/agentscope";
const image =
  "node@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
const imageId =
  "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6";
const innerReceipt = Buffer.from('{"version":1,"status":"passed"}\n');
const innerReceiptDigest =
  "709d35b6bbb00dad49454715be8809fda10f96a50219caca8fbed53594b488d1";
const maximumOutputBytes = 16 * 1024;
const totalMilliseconds = 90_000;
const teardownReserveMilliseconds = 7_000;
const stages = Object.freeze([
  "setup",
  "input-identity",
  "image-identity",
  "create",
  "runtime-receipt",
  "terminal-join",
  "cleanup",
  "final-assertion",
]);

class ControllerFailure extends Error {
  constructor(code, outcome = "failure") {
    super(code);
    this.code = code;
    this.outcome = outcome;
  }
}

const remainingMilliseconds = (deadline) =>
  Math.max(0, Math.floor(deadline - performance.now()));

const groupExists = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new ControllerFailure("process-group-uncertain", "uncertain");
  }
};

const readProcessStartIdentity = (pid) => {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = value.lastIndexOf(")");
  const fields = value
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const start = fields[19];
  if (close < 2 || start === undefined || !/^[0-9]+$/u.test(start))
    throw new ControllerFailure("process-start-identity-invalid", "uncertain");
  return start;
};

/* eslint-disable max-lines-per-function -- Process identity, output, deadline, signal, and join authority must settle in one closure. */
export const runBoundedProcess = (
  file,
  args,
  {
    absoluteDeadline,
    cwd,
    env,
    onActive = () => {},
    readStartIdentity = readProcessStartIdentity,
  },
) =>
  new Promise((resolveRun, rejectRun) => {
    if (
      typeof file !== "string" ||
      !file.startsWith("/") ||
      !Array.isArray(args) ||
      args.some((value) => typeof value !== "string" || value.includes("\0")) ||
      remainingMilliseconds(absoluteDeadline) <= teardownReserveMilliseconds
    ) {
      rejectRun(new ControllerFailure("command-invalid"));
      return;
    }
    const commandDeadline =
      absoluteDeadline - teardownReserveMilliseconds - performance.now();
    const child = spawn(file, args, {
      cwd,
      detached: true,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let forcedOutcome;
    let startIdentity;
    let timer;
    let killTimer;
    let hardTimer;
    const terminate = (signal = "SIGTERM") => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (readStartIdentity(child.pid) !== startIdentity)
          throw new ControllerFailure(
            "process-start-identity-mismatch",
            "uncertain",
          );
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH")
          settle(
            error instanceof ControllerFailure
              ? error
              : new ControllerFailure("process-signal-uncertain", "uncertain"),
          );
      }
    };
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      onActive(undefined);
      if (error !== undefined) rejectRun(error);
      else resolveRun(result);
    };
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        forcedOutcome = "overflow";
        terminate();
        killTimer = setTimeout(
          () => terminate("SIGKILL"),
          Math.min(1_000, remainingMilliseconds(absoluteDeadline)),
        );
        return;
      }
      target.push(chunk);
    };
    child.once("spawn", () => {
      if (child.pid === undefined) {
        settle(new ControllerFailure("spawn-identity-missing"));
        return;
      }
      try {
        startIdentity = readStartIdentity(child.pid);
      } catch (error) {
        settle(
          error instanceof ControllerFailure
            ? error
            : new ControllerFailure(
                "process-start-identity-unavailable",
                "uncertain",
              ),
        );
        return;
      }
      onActive(Object.freeze({ pid: child.pid, terminate }));
      timer = setTimeout(
        () => {
          forcedOutcome = "timeout";
          terminate();
          killTimer = setTimeout(
            () => terminate("SIGKILL"),
            Math.min(1_000, remainingMilliseconds(absoluteDeadline)),
          );
        },
        Math.max(1, commandDeadline),
      );
      hardTimer = setTimeout(
        () => {
          forcedOutcome = "uncertain";
          terminate("SIGKILL");
          settle(
            new ControllerFailure("process-terminal-unproved", "uncertain"),
          );
        },
        Math.max(1, remainingMilliseconds(absoluteDeadline)),
      );
    });
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => settle(new ControllerFailure("spawn-failed")));
    child.once("close", (status, signal) => {
      if (child.pid === undefined) {
        settle(new ControllerFailure("spawn-identity-missing"));
        return;
      }
      let survivor;
      try {
        survivor = groupExists(child.pid);
      } catch (error) {
        settle(error);
        return;
      }
      if (survivor) {
        settle(new ControllerFailure("process-group-survived", "uncertain"));
        return;
      }
      if (forcedOutcome === "timeout") {
        settle(new ControllerFailure("command-timeout", "timeout"));
        return;
      }
      if (forcedOutcome === "overflow") {
        settle(new ControllerFailure("command-output-overflow"));
        return;
      }
      if (forcedOutcome === "uncertain") {
        settle(new ControllerFailure("process-terminal-unproved", "uncertain"));
        return;
      }
      if (outputBytes > maximumOutputBytes) {
        settle(new ControllerFailure("command-output-overflow"));
        return;
      }
      if (remainingMilliseconds(absoluteDeadline) === 0) {
        settle(new ControllerFailure("command-timeout", "timeout"));
        return;
      }
      settle(undefined, {
        signal,
        status,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
  });
/* eslint-enable max-lines-per-function */

const exactRegularFile = (path, executable = false) => {
  const value = lstatSync(path);
  return (
    value.isFile() &&
    !value.isSymbolicLink() &&
    (!executable || (value.mode & 0o111) !== 0)
  );
};

const exactSocket = (path) => {
  const value = lstatSync(path);
  return value.isSocket() && !value.isSymbolicLink();
};

const exactOutput = (result) => {
  if (result.status !== 0 || result.signal !== null)
    throw new ControllerFailure("command-failed");
  return result.stdout;
};

// eslint-disable-next-line max-lines-per-function -- This closed adapter keeps the Docker lifecycle in one authority object.
export const createProductionOperations = ({ absoluteDeadline }) => {
  let root;
  let rootIdentity;
  let containerId;
  let created = false;
  let activeCommand;
  let processUncertain = false;
  let signalLatch = () => false;
  const closedEnvironment = () => ({
    DOCKER_CONFIG: resolve(root, "config"),
    HOME: root,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  });
  const command = async (args) => {
    if (processUncertain)
      throw new ControllerFailure("process-authority-uncertain", "uncertain");
    try {
      return await runBoundedProcess(
        dockerPath,
        [
          "--config",
          resolve(root, "config"),
          "--host",
          `unix://${dockerSocket}`,
          ...args,
        ],
        {
          absoluteDeadline,
          cwd: repositoryPath,
          env: closedEnvironment(),
          onActive: (value) => {
            activeCommand = value;
          },
        },
      );
    } catch (error) {
      if (error instanceof ControllerFailure && error.outcome === "uncertain")
        processUncertain = true;
      throw error;
    }
  };
  const requireOutput = async (args) => exactOutput(await command(args));
  const installSignalHandlers = (latch) => {
    signalLatch = latch;
    const handler = (signal) => {
      if (signalLatch(signal)) activeCommand?.terminate(signal);
    };
    const interrupt = () => handler("SIGINT");
    const terminate = () => handler("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    return () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
  };
  return {
    installSignalHandlers,
    async setup() {
      root = mkdtempSync(resolve(tmpdir(), "agentscope-pty-runtime."));
      chmodSync(root, 0o700);
      rootIdentity = lstatSync(root);
      mkdirSync(resolve(root, "config"), { mode: 0o700 });
    },
    async inputIdentity() {
      if (
        !exactRegularFile(dockerPath, true) ||
        !exactSocket(dockerSocket) ||
        realpathSync(".") !== repositoryPath ||
        !exactRegularFile(
          resolve(
            repositoryPath,
            "packages/testkit/pty-runtime/node127-linux-x64-musl/pty.node",
          ),
        ) ||
        !exactRegularFile(
          resolve(
            repositoryPath,
            "packages/testkit/fixtures/pty-runtime-faults/node127-linux-x64-musl/pty.node",
          ),
        )
      )
        throw new ControllerFailure("input-identity-invalid");
      const existing = await requireOutput([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--quiet",
        "--filter",
        "name=^/agentscope-pty-runtime-proof-",
      ]);
      if (existing.length !== 0)
        throw new ControllerFailure("preexisting-container");
    },
    async imageIdentity() {
      exactOutput(
        await command(["pull", "--quiet", "--platform", "linux/amd64", image]),
      );
      const identity = await requireOutput([
        "image",
        "inspect",
        "--format",
        "{{.Id}}|{{.Os}}|{{.Architecture}}",
        imageId,
      ]);
      if (identity.toString("utf8").trimEnd() !== `${imageId}|linux|amd64`)
        throw new ControllerFailure("image-identity-invalid");
    },
    async create() {
      const name = `agentscope-pty-runtime-proof-${randomBytes(16).toString("hex")}`;
      const reported = await requireOutput([
        "create",
        "--name",
        name,
        "--network",
        "none",
        "--platform",
        "linux/amd64",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,mode=0700,size=16m",
        "--mount",
        `type=bind,src=${repositoryPath}/packages/testkit/pty-runtime/node127-linux-x64-musl/pty.node,dst=/runtime/production.node,readonly`,
        "--mount",
        `type=bind,src=${repositoryPath}/packages/testkit/fixtures/pty-runtime-faults/node127-linux-x64-musl/pty.node,dst=/runtime/faults.node,readonly`,
        "--mount",
        `type=bind,src=${repositoryPath},dst=/workspace,readonly`,
        image,
        "/usr/local/bin/node",
        "/workspace/packages/testkit/scripts/verify-pty-runtime.mjs",
        "--runtime-proof",
      ]);
      const value = reported.toString("utf8").trimEnd();
      if (!/^[0-9a-f]{64}$/u.test(value))
        throw new ControllerFailure("container-identity-invalid");
      containerId = value;
      created = true;
      const authority = await requireOutput([
        "inspect",
        "--format",
        "{{.Id}}|{{.Image}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.State.Status}}",
        containerId,
      ]);
      if (
        authority.toString("utf8").trimEnd() !==
        `${containerId}|${imageId}|none|true|created`
      )
        throw new ControllerFailure("container-authority-invalid");
    },
    async runtimeReceipt() {
      const receipt = await requireOutput(["start", "--attach", containerId]);
      if (
        receipt.length !== innerReceipt.length ||
        createHash("sha256").update(receipt).digest("hex") !==
          innerReceiptDigest ||
        !receipt.equals(innerReceipt)
      )
        throw new ControllerFailure("runtime-receipt-invalid");
    },
    async terminalJoin() {
      const terminal = await requireOutput([
        "inspect",
        "--format",
        "{{.State.Status}}|{{.State.ExitCode}}|{{.State.Running}}|{{.State.Pid}}",
        containerId,
      ]);
      if (terminal.toString("utf8").trimEnd() !== "exited|0|false|0")
        throw new ControllerFailure("terminal-join-invalid");
    },
    async finalAssertion() {},
    async cleanup() {
      let proved = true;
      if (processUncertain) proved = false;
      if (!processUncertain && created && /^[0-9a-f]{64}$/u.test(containerId)) {
        try {
          exactOutput(await command(["rm", "--force", containerId]));
          const survivor = await requireOutput([
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--quiet",
            "--filter",
            `id=${containerId}`,
          ]);
          if (survivor.length !== 0) proved = false;
        } catch {
          proved = false;
        }
      }
      try {
        const current = lstatSync(root);
        if (
          current.dev !== rootIdentity.dev ||
          current.ino !== rootIdentity.ino ||
          !current.isDirectory() ||
          current.isSymbolicLink()
        ) {
          proved = false;
        } else {
          rmSync(root, { recursive: true, force: false });
        }
      } catch {
        proved = false;
      }
      if (
        activeCommand !== undefined ||
        remainingMilliseconds(absoluteDeadline) === 0
      )
        proved = false;
      return proved;
    },
  };
};

export const executeController = async ({
  absoluteDeadline = performance.now() + totalMilliseconds,
  operations = createProductionOperations({ absoluteDeadline }),
} = {}) => {
  let stage = "setup";
  let originalOutcome = "success";
  let runtimeReceiptAuthenticated = false;
  let signal = null;
  let cleanupProved;
  let settled = false;
  const latchSignal = (value) => {
    if (settled || signal !== null) return false;
    signal = value === "SIGINT" ? "SIGINT" : "SIGTERM";
    originalOutcome = "signal";
    return true;
  };
  const uninstall =
    operations.installSignalHandlers?.(latchSignal) ?? (() => {});
  try {
    for (const [nextStage, action] of [
      ["setup", "setup"],
      ["input-identity", "inputIdentity"],
      ["image-identity", "imageIdentity"],
      ["create", "create"],
      ["runtime-receipt", "runtimeReceipt"],
      ["terminal-join", "terminalJoin"],
      ["final-assertion", "finalAssertion"],
    ]) {
      stage = nextStage;
      if (signal !== null) throw new ControllerFailure("signal", "signal");
      if (remainingMilliseconds(absoluteDeadline) === 0)
        throw new ControllerFailure("deadline", "timeout");
      await operations[action]();
      if (nextStage === "runtime-receipt") runtimeReceiptAuthenticated = true;
    }
  } catch (error) {
    if (originalOutcome === "success")
      originalOutcome =
        error instanceof ControllerFailure ? error.outcome : "failure";
  } finally {
    try {
      cleanupProved = (await operations.cleanup()) === true;
    } catch {
      cleanupProved = false;
    }
    uninstall();
    settled = true;
  }
  const passed =
    originalOutcome === "success" &&
    signal === null &&
    stage === "final-assertion" &&
    runtimeReceiptAuthenticated &&
    cleanupProved;
  if (!passed && originalOutcome === "success") originalOutcome = "uncertain";
  if (!cleanupProved) stage = "cleanup";
  if (!stages.includes(stage)) stage = "cleanup";
  return Object.freeze({
    receipt: Object.freeze({
      version: 1,
      stage,
      status: passed ? "passed" : "failed",
      runtimeReceiptAuthenticated,
      cleanupProved,
      originalOutcome,
      signal,
    }),
    exitCode: passed
      ? 0
      : signal === "SIGINT"
        ? 130
        : signal === "SIGTERM"
          ? 143
          : 1,
  });
};

export const main = async () => {
  const { exitCode, receipt } = await executeController();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = exitCode;
};

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
