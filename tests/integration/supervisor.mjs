import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { isAbsolute, resolve } from "node:path";

const containmentProofMilliseconds = 5_000;
const containmentPollMilliseconds = 10;
const systemdTerminationGraceMilliseconds = 1_000;
const maximumToolOutputBytes = 64 * 1024;
const sudoPath = "/usr/bin/sudo";
const systemctlPath = "/usr/bin/systemctl";
const systemdRunPath = "/usr/bin/systemd-run";
const cgroupRoot = "/sys/fs/cgroup";
const systemdPath = "/usr/lib/systemd/systemd";

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const signalGroup = (processGroup, signal) => {
  try {
    if (process.platform === "win32") process.kill(processGroup, signal);
    else process.kill(-processGroup, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

const groupIsAbsent = (processGroup) => {
  try {
    if (process.platform === "win32") process.kill(processGroup, 0);
    else process.kill(-processGroup, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
};

const proveGroupAbsent = async (processGroup) => {
  const deadline = performance.now() + containmentProofMilliseconds;
  while (performance.now() < deadline) {
    if (groupIsAbsent(processGroup)) return true;
    await delay(containmentPollMilliseconds);
  }
  return groupIsAbsent(processGroup);
};

const runProcessGroupSupervised = async ({
  arguments_: arguments_ = [],
  environment,
  executable,
  maximumMilliseconds,
  stdio = "inherit",
}) => {
  const child = spawn(executable, arguments_, {
    detached: process.platform !== "win32",
    env: environment,
    stdio,
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1)
    throw new Error("integration.controller.spawn");
  const processGroup = child.pid;
  let forcedTimer;
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalGroup(processGroup, "SIGTERM");
    forcedTimer = setTimeout(() => {
      signalGroup(processGroup, "SIGKILL");
    }, containmentProofMilliseconds);
  };
  const deadlineTimer = setTimeout(terminate, maximumMilliseconds);
  const forwardSignal = () => {
    terminate();
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      child.once("error", rejectResult);
      child.once("close", (code, signal) => {
        resolveResult({ code, signal });
      });
    });
    clearTimeout(deadlineTimer);
    if (forcedTimer !== undefined) clearTimeout(forcedTimer);
    const residualWorkObserved = signalGroup(processGroup, "SIGKILL");
    const contained = await proveGroupAbsent(processGroup);
    return { ...result, contained, residualWorkObserved };
  } finally {
    clearTimeout(deadlineTimer);
    if (forcedTimer !== undefined) clearTimeout(forcedTimer);
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }
};

const failSystemd = () => {
  throw new Error("integration.controller.systemd-containment");
};

const readBounded = (path, maximumBytes) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size > maximumBytes) failSystemd();
    const content = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < content.length) {
      const count = readSync(
        descriptor,
        content,
        size,
        content.length - size,
        null,
      );
      if (count === 0) break;
      size += count;
    }
    if (size > maximumBytes) failSystemd();
    return content.subarray(0, size).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
};

const authenticateExecutable = (path, mode) => {
  if (realpathSync(path) !== path) failSystemd();
  const status = statSync(path);
  if (
    !status.isFile() ||
    status.uid !== 0 ||
    (status.mode & 0o022) !== 0 ||
    (status.mode & mode) !== mode
  )
    failSystemd();
};

const authenticateSystemdHost = () => {
  if (
    process.platform !== "linux" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.getuid?.() === 0 ||
    realpathSync("/proc/1/exe") !== systemdPath
  )
    failSystemd();
  const manager = statSync(systemdPath);
  if (!manager.isFile() || manager.uid !== 0 || (manager.mode & 0o022) !== 0)
    failSystemd();
  authenticateExecutable(sudoPath, 0o4000);
  authenticateExecutable(systemctlPath, 0o111);
  authenticateExecutable(systemdRunPath, 0o111);
  const mounts = readBounded("/proc/self/mountinfo", 1024 * 1024)
    .trimEnd()
    .split("\n")
    .filter((line) => line.includes(" - cgroup2 "));
  if (
    mounts.length !== 1 ||
    mounts[0].split(" ")[4] !== cgroupRoot ||
    !existsSync(resolve(cgroupRoot, "cgroup.controllers"))
  )
    failSystemd();
};

const remainingMilliseconds = (deadline) => {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) failSystemd();
  return remaining;
};

const runTool = (executable, arguments_, deadline) =>
  new Promise((resolveTool, rejectTool) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const child = spawn(executable, arguments_, {
      detached: true,
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      signalGroup(child.pid, "SIGKILL");
    }, remainingMilliseconds(deadline));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolveTool(value);
      else rejectTool(error);
    };
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumToolOutputBytes) signalGroup(child.pid, "SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || size > maximumToolOutputBytes)
        finish(new Error("integration.controller.systemd-tool"));
      else finish(undefined, Buffer.concat(chunks).toString("utf8"));
    });
  });

const rootTool = (path, arguments_, deadline) =>
  runTool(sudoPath, ["-n", "--", path, ...arguments_], deadline);

const exactUnitFacts = (output) => {
  if (Buffer.byteLength(output) > maximumToolOutputBytes) failSystemd();
  const entries = output.trimEnd().split("\n");
  const facts = Object.create(null);
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) failSystemd();
    const key = entry.slice(0, separator);
    if (Object.hasOwn(facts, key)) failSystemd();
    facts[key] = entry.slice(separator + 1);
  }
  return facts;
};

const unitProperties = [
  "ActiveState",
  "ControlGroup",
  "Delegate",
  "ExecMainCode",
  "ExecMainStatus",
  "Group",
  "Id",
  "KillMode",
  "LoadState",
  "RemainAfterExit",
  "Result",
  "SubState",
  "SupplementaryGroups",
  "User",
];

const showUnit = async (unit, deadline) =>
  exactUnitFacts(
    await rootTool(
      systemctlPath,
      [
        "show",
        "--no-pager",
        ...unitProperties.map((property) => `--property=${property}`),
        unit,
      ],
      deadline,
    ),
  );

const assertUnitAuthority = (facts, authority) => {
  if (
    facts.Id !== authority.unit ||
    facts.LoadState !== "loaded" ||
    facts.ControlGroup !== authority.cgroup ||
    facts.Delegate !== "no" ||
    facts.KillMode !== "control-group" ||
    facts.RemainAfterExit !== "yes" ||
    facts.User !== String(authority.uid) ||
    facts.Group !== String(authority.gid) ||
    facts.SupplementaryGroups !== authority.groups.join(" ")
  )
    failSystemd();
};

const authenticateCgroup = (cgroupPath) => {
  for (const path of [cgroupPath, resolve(cgroupPath, "cgroup.procs")]) {
    const status = statSync(path);
    if (status.uid !== 0 || status.gid !== 0 || (status.mode & 0o022) !== 0)
      failSystemd();
  }
};

const cgroupIsEmpty = (cgroupPath) => {
  const events = readBounded(resolve(cgroupPath, "cgroup.events"), 4096);
  const entries = Object.fromEntries(
    events
      .trimEnd()
      .split("\n")
      .map((line) => line.split(" ")),
  );
  return entries.populated === "0";
};

const waitForTerminal = async (authority, deadline, interrupted) => {
  while (!interrupted.value && performance.now() < deadline) {
    const facts = await showUnit(authority.unit, deadline);
    assertUnitAuthority(facts, authority);
    if (
      (facts.ActiveState === "active" && facts.SubState === "exited") ||
      facts.ActiveState === "failed"
    )
      return facts;
    await delay(Math.min(50, remainingMilliseconds(deadline)));
  }
  return undefined;
};

const systemdSignal = (unit, signal, deadline) =>
  rootTool(
    systemctlPath,
    ["kill", "--kill-whom=all", `--signal=${signal}`, unit],
    deadline,
  );

const proveCollected = async (authority, cgroupPath, deadline) => {
  while (performance.now() < deadline) {
    const facts = await showUnit(authority.unit, deadline);
    if (facts.LoadState === "not-found" && !existsSync(cgroupPath)) return true;
    await delay(Math.min(50, remainingMilliseconds(deadline)));
  }
  return false;
};

const retireUnit = async (authority, deadline) => {
  const facts = await showUnit(authority.unit, deadline);
  if (facts.LoadState === "not-found") return;
  assertUnitAuthority(facts, authority);
  if (facts.ActiveState === "failed")
    await rootTool(systemctlPath, ["reset-failed", authority.unit], deadline);
  else await rootTool(systemctlPath, ["stop", authority.unit], deadline);
};

const systemdEnvironmentArguments = (environment) =>
  Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (
        !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) ||
        typeof value !== "string" ||
        value.length > 4096 ||
        /[\0\r\n]/u.test(value)
      )
        failSystemd();
      return `--setenv=${name}=${value}`;
    });

const systemdIdentity = (environment) => {
  if (
    !/^\d+$/u.test(environment.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/u.test(environment.GITHUB_RUN_ATTEMPT ?? "") ||
    !/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? "") ||
    !/^\d+\/\d+$/u.test(environment.AGENTSCOPE_INTEGRATION_SHARD ?? "") ||
    !/^[12]$/u.test(environment.AGENTSCOPE_INTEGRATION_REPLAY ?? "") ||
    environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
    environment.GITHUB_JOB !== "hermetic-platform" ||
    environment.GITHUB_REPOSITORY !== "Melbourneandrew/agentscope"
  )
    failSystemd();
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        attempt: environment.GITHUB_RUN_ATTEMPT,
        nonce: randomBytes(16).toString("hex"),
        run: environment.GITHUB_RUN_ID,
        replay: environment.AGENTSCOPE_INTEGRATION_REPLAY,
        sha: environment.GITHUB_SHA,
        shard: environment.AGENTSCOPE_INTEGRATION_SHARD,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const unit = `agentscope-${digest}.service`;
  const groups = [...new Set(process.getgroups())].sort(
    (left, right) => left - right,
  );
  return Object.freeze({
    cgroup: `/system.slice/${unit}`,
    gid: process.getgid(),
    groups: Object.freeze(groups),
    uid: process.getuid(),
    unit,
  });
};

const runSystemdSupervised = async ({
  arguments_: arguments_ = [],
  environment,
  executable,
  maximumMilliseconds,
}) => {
  authenticateSystemdHost();
  if (
    !Number.isSafeInteger(maximumMilliseconds) ||
    maximumMilliseconds < 1 ||
    !isAbsolute(executable) ||
    realpathSync(executable) !== executable
  )
    failSystemd();
  const executableStatus = statSync(executable);
  if (!executableStatus.isFile() || (executableStatus.mode & 0o022) !== 0)
    failSystemd();
  const deadline = performance.now() + maximumMilliseconds;
  const executionDeadline = deadline - containmentProofMilliseconds;
  if (executionDeadline <= performance.now()) failSystemd();
  const authority = systemdIdentity(environment);
  const cgroupPath = resolve(cgroupRoot, authority.cgroup.slice(1));
  if (existsSync(cgroupPath)) failSystemd();
  const interrupted = { value: false };
  const forwardSignal = () => {
    interrupted.value = true;
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  let terminal;
  let residualWorkObserved;
  try {
    await rootTool(
      systemdRunPath,
      [
        `--unit=${authority.unit}`,
        "--service-type=exec",
        "--property=Delegate=no",
        "--property=KillMode=control-group",
        "--property=RemainAfterExit=yes",
        `--property=User=${authority.uid}`,
        `--property=Group=${authority.gid}`,
        `--property=SupplementaryGroups=${authority.groups.join(" ")}`,
        "--expand-environment=no",
        `--working-directory=${process.cwd()}`,
        ...systemdEnvironmentArguments(environment),
        "--",
        executable,
        ...arguments_,
      ],
      deadline,
    );
    terminal = await waitForTerminal(authority, executionDeadline, interrupted);
    const authoritative = await showUnit(authority.unit, deadline);
    assertUnitAuthority(authoritative, authority);
    authenticateCgroup(cgroupPath);
    residualWorkObserved = !cgroupIsEmpty(cgroupPath);
    if (residualWorkObserved) {
      await systemdSignal(authority.unit, "SIGTERM", deadline);
      const grace = Math.min(
        deadline,
        performance.now() + systemdTerminationGraceMilliseconds,
      );
      while (performance.now() < grace && !cgroupIsEmpty(cgroupPath))
        await delay(Math.min(50, remainingMilliseconds(deadline)));
      if (!cgroupIsEmpty(cgroupPath))
        await systemdSignal(authority.unit, "SIGKILL", deadline);
    }
    while (!cgroupIsEmpty(cgroupPath))
      await delay(Math.min(50, remainingMilliseconds(deadline)));
    await retireUnit(authority, deadline);
    const contained = await proveCollected(authority, cgroupPath, deadline);
    if (!contained || terminal === undefined)
      return {
        code: null,
        contained: false,
        residualWorkObserved,
        signal: null,
      };
    const code = Number(terminal.ExecMainStatus);
    if (
      terminal.ExecMainCode !== "exited" ||
      !Number.isSafeInteger(code) ||
      code < 0 ||
      code > 255 ||
      !new Set(["success", "exit-code"]).has(terminal.Result)
    )
      return {
        code: null,
        contained: false,
        residualWorkObserved,
        signal: null,
      };
    return { code, contained: true, residualWorkObserved, signal: null };
  } catch {
    try {
      if (existsSync(cgroupPath)) {
        await systemdSignal(authority.unit, "SIGKILL", deadline);
        while (!cgroupIsEmpty(cgroupPath))
          await delay(Math.min(50, remainingMilliseconds(deadline)));
        await retireUnit(authority, deadline);
      }
    } catch {
      // The caller receives terminal uncertainty below.
    }
    return {
      code: null,
      contained: false,
      residualWorkObserved: true,
      signal: null,
    };
  } finally {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }
};

export const runSupervisedProcess = async (options) =>
  options.containment === "github-systemd"
    ? runSystemdSupervised(options)
    : runProcessGroupSupervised(options);
