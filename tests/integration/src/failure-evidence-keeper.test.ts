import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const keeper = resolve(
  workspaceRoot,
  "tests/integration/failure-evidence-keeper.py",
);
const python = "/usr/bin/python3";
const bundle = Buffer.from(
  '{"bundleVersion":1,"controllerAuthorityDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","preparedInput":{},"retainedInputs":{},"runs":[]}\n',
);
const deadline = () => (process.hrtime.bigint() + 30_000_000_000n).toString();
const invoke = (arguments_: string[], input?: Buffer, stdio?: unknown[]) =>
  spawnSync(python, [keeper, ...arguments_], {
    env: {},
    input,
    maxBuffer: 4096,
    stdio: stdio as never,
    timeout: 5000,
  });
const parseReceipt = (output: Buffer) =>
  JSON.parse(output.toString("utf8")) as {
    digest: string;
    fd: number;
    keeperReceiptVersion: number;
    pid: number;
    size: number;
    startTimeTicks: string;
  };
const identity = (receipt: ReturnType<typeof parseReceipt>) => [
  String(receipt.pid),
  receipt.startTimeTicks,
  String(receipt.fd),
  String(receipt.size),
  receipt.digest,
];

describe("failure evidence keeper policy", () => {
  it("pins sealing before publication and has no persistent evidence path", () => {
    const source = readFileSync(keeper, "utf8");
    const seal = source.indexOf("fcntl.F_ADD_SEALS");
    const fork = source.indexOf("os.fork()", seal);
    const receipt = source.indexOf('"keeperReceiptVersion": 1', fork);
    expect(seal).toBeGreaterThanOrEqual(0);
    expect(fork).toBeGreaterThan(seal);
    expect(receipt).toBeGreaterThan(fork);
    expect(source).toContain("os.memfd_create");
    expect(source).toContain("F_SEAL_WRITE");
    expect(source).toContain("F_SEAL_GROW");
    expect(source).toContain("F_SEAL_SHRINK");
    expect(source).toContain("F_SEAL_SEAL");
    expect(source).not.toMatch(
      /NamedTemporaryFile|mkstemp|TemporaryDirectory/gu,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "holds immutable bytes under exact process and descriptor identity",
    () => {
      const held = invoke(["hold", deadline()], bundle);
      expect(held.status).toBe(0);
      expect(held.stderr).toEqual(Buffer.alloc(0));
      const receipt = parseReceipt(held.stdout);
      const procPath = `/proc/${receipt.pid}/fd/${receipt.fd}`;
      expect(readFileSync(procPath)).toEqual(bundle);
      expect(invoke(["inspect", ...identity(receipt)]).status).toBe(0);
      const modeAuthority = openSync(procPath, constants.O_RDONLY);
      fchmodSync(modeAuthority, 0o600);
      closeSync(modeAuthority);
      const writable = openSync(procPath, constants.O_RDWR);
      try {
        expect(() => writeSync(writable, Buffer.from("x"))).toThrow();
        expect(() => {
          ftruncateSync(writable, 0);
        }).toThrow();
        expect(() => {
          ftruncateSync(writable, receipt.size + 1);
        }).toThrow();
        fchmodSync(writable, 0o400);
      } finally {
        closeSync(writable);
      }
      expect(readFileSync(procPath)).toEqual(bundle);
      expect(
        invoke(["retire", ...identity(receipt), deadline()]).stdout.toString(
          "utf8",
        ),
      ).toBe('{"status":"retired"}\n');
      expect(invoke(["inspect", ...identity(receipt)]).status).not.toBe(0);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects descriptor, process, deadline, and inherited-FD ambiguity",
    () => {
      const held = invoke(["hold", deadline()], bundle);
      expect(held.status).toBe(0);
      const receipt = parseReceipt(held.stdout);
      expect(
        invoke([
          "inspect",
          String(receipt.pid),
          `${receipt.startTimeTicks}0`,
          String(receipt.fd),
          String(receipt.size),
          receipt.digest,
        ]).status,
      ).not.toBe(0);
      expect(
        invoke([
          "inspect",
          String(receipt.pid),
          receipt.startTimeTicks,
          String(receipt.fd + 1),
          String(receipt.size),
          receipt.digest,
        ]).status,
      ).not.toBe(0);
      expect(
        invoke([
          "inspect",
          ...identity(receipt).slice(0, -1),
          `sha256:${"0".repeat(64)}`,
        ]).status,
      ).not.toBe(0);
      expect(invoke(["hold", "1"], bundle).status).not.toBe(0);
      expect(invoke(["inspect", "malformed"]).status).not.toBe(0);
      const extra = openSync("/dev/null", constants.O_RDONLY);
      try {
        expect(
          invoke(["hold", deadline()], bundle, ["pipe", "pipe", "pipe", extra])
            .status,
        ).not.toBe(0);
      } finally {
        closeSync(extra);
      }
      expect(invoke(["retire", ...identity(receipt), deadline()]).status).toBe(
        0,
      );
    },
  );
});
