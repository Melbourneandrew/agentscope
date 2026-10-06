import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  verifyBootstrapGpgListing,
  verifyBootstrapGpgStatus,
} from "../mockserver-material/bootstrap-gpg.mjs";

const now = 1_800_000_000;
const created = 1_700_000_000;
const policies = [
  ["maven", "84789D24DF77A32433CE1F079EB80E92EB2135B1", "10", "00"],
  ["node", "C0D6248439F1D5604AAFFB4021D900FFDB233756", "8", "01"],
  ["jdk", "3B04D753C9050D9A5D343F39843C48A565F8F04B", "10", "00"],
] as const;
const status = (fingerprint: string, hash: string, signatureClass: string) =>
  `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG ${fingerprint.slice(-16)} Synthetic Release\n[GNUPG:] VALIDSIG ${fingerprint} 2023-11-14 ${created} 0 4 0 1 ${hash} ${signatureClass} ${fingerprint}\n`;
const listing = (fingerprint: string) =>
  `pub:-:4096:1:${fingerprint.slice(-16)}:${created - 1}:0:::::scSC:\nfpr:::::::::${fingerprint}:\nuid:-::::${created - 1}::canary::Synthetic Release:\n`;

type Execute = (
  ...values: unknown[]
) => Promise<{ stdout: string | Buffer; stderr?: string }>;
type Verification = (kind: string, execute: Execute) => Promise<void>;
type Enter = (stage: string, family: string) => void;
const statusVerifier = () => {
  const source = readFileSync(
    new URL("../mockserver-material/bootstrap-gpg.mjs", import.meta.url),
    "utf8",
  );
  return runInNewContext(
    source
      .slice(
        source.indexOf("const seconds ="),
        source.indexOf("export const verifyBootstrapGpgListing"),
      )
      .replaceAll("export const", "const") + "\nverifyStatus;",
    {
      Buffer,
      Date,
      policyFor: () => ({
        primary: policies[0][1],
        hash: "10",
        signatureClass: "00",
      }),
      fail: () => {
        throw new Error("integration.mockserver-material.bootstrap-gpg");
      },
    },
    { timeout: 1_000 },
  ) as (
    kind: string,
    output: string,
    now: number,
    enter: Enter,
  ) => { created: number; expiry: number };
};
function observedVerification(options: {
  authentication?: () => void;
  mkdir?: () => void;
  write?: (text: string) => void;
  listing?: () => { created: number; expiry: number };
  signature?: ReturnType<typeof statusVerifier>;
  manifest?: () => Buffer;
}) {
  const source = readFileSync(
    new URL("../mockserver-material/bootstrap-gpg.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(source.indexOf("const runVerification ="));
  return runInNewContext(
    body.replaceAll("export const", "const") + "\nrunBootstrapGpgVerification;",
    {
      Buffer,
      Date,
      resolve,
      policyFor: () => ({ primary: policies[0][1] }),
      objects: { maven: [["key", 1, "fixed"]], node: [["key", 1, "fixed"]] },
      authenticateObject: options.authentication ?? (() => undefined),
      mkdirSync: options.mkdir ?? (() => undefined),
      writeFileSync: () => undefined,
      writeSync: (_fd: number, text: string) => options.write?.(text),
      verifyBootstrapGpgListing:
        options.listing ?? (() => ({ created: 1, expiry: 0 })),
      verifyStatus: options.signature ?? (() => ({ created: 2, expiry: 0 })),
      readFileSync: options.manifest ?? (() => Buffer.alloc(3777)),
      argumentsFor: () => [],
      fail: () => {
        throw new Error("integration.mockserver-material.bootstrap-gpg");
      },
    },
    { timeout: 1_000 },
  ) as Verification;
}

describe("actual bootstrap run body observations (no GPG execution)", () => {
  it.each([
    "input",
    "filesystem",
    "gpg-execution",
    "listing-policy",
    "signature-policy",
    "checksum-policy",
  ])(
    "preserves the exact original %s rejection despite diagnostic write failure",
    async (family) => {
      const primary = new Error("SECRET_CANARY");
      const markers: string[] = [];
      const reject = () => {
        throw primary;
      };
      const run = observedVerification({
        ...(family === "input" ? { authentication: reject } : {}),
        ...(family === "filesystem" ? { mkdir: reject } : {}),
        ...(family === "listing-policy" ? { listing: reject } : {}),
        ...(family === "signature-policy" ? { signature: reject } : {}),
        ...(family === "checksum-policy" ? { manifest: reject } : {}),
        write: (text) => {
          markers.push(text);
          throw new Error("optional-write");
        },
      });
      await expect(
        run(family === "checksum-policy" ? "node" : "maven", () =>
          family === "gpg-execution"
            ? Promise.reject(primary)
            : Promise.resolve({ stdout: Buffer.from("selected") }),
        ),
      ).rejects.toBe(primary);
      expect(markers.at(-1)).toContain(`family=${family}]\n`);
      expect(markers.join("")).not.toContain("SECRET_CANARY");
    },
  );

  it("keeps actual synthetic success when every optional marker write throws", async () => {
    const markers: string[] = [];
    const run = observedVerification({
      write: (text) => {
        markers.push(text);
        throw new Error("optional-write");
      },
    });
    await expect(
      run("maven", () => Promise.resolve({ stdout: Buffer.from("selected") })),
    ).resolves.toBeUndefined();
    expect(markers.at(-1)).toBe(
      "[agentscope-material:v1 stage=completed family=none]\n",
    );
  });
});

describe("fixed signature-policy substages (untrusted observations only)", () => {
  const valid = status(policies[0][1], "10", "00");
  it.each([
    [
      "information",
      ["NOTATION_NAME", "NOTATION_FLAGS", "NOTATION_DATA", "POLICY_URL"],
    ],
    [
      "rejection",
      [
        "BADSIG",
        "ERRSIG",
        "EXPSIG",
        "EXPKEYSIG",
        "REVKEYSIG",
        "NO_PUBKEY",
        "KEYEXPIRED",
        "KEYREVOKED",
        "SIGEXPIRED",
      ],
    ],
    ["unknown", ["UNKNOWN_CANARY", "", "NOTATION_NAME_CANARY"]],
  ] as const)(
    "still rejects every %s record without disclosing its payload",
    (category, tokens) => {
      for (const token of tokens) {
        const entered: string[] = [];
        const text =
          valid +
          `[GNUPG:] ${token} SECRET_CANARY\n[GNUPG:] BADSIG SECOND_CANARY\n`;
        for (const sinkThrows of [false, true]) {
          expect(() =>
            statusVerifier()("maven", text, now, (stage) => {
              entered.push(stage);
              if (stage === `signature-recordset-${category}` && sinkThrows)
                throw new Error("optional-sink-canary");
            }),
          ).toThrow("integration.mockserver-material.bootstrap-gpg");
        }
        expect(entered.at(-1)).toBe(`signature-recordset-${category}`);
        expect(entered.join(" ")).not.toContain("CANARY");
        for (const kind of ["maven", "node", "jdk"] as const)
          expect(() => verifyBootstrapGpgStatus(kind, text, now)).toThrow(
            "integration.mockserver-material.bootstrap-gpg",
          );
      }
    },
  );
  it.each([
    ["recordset-rejection", valid + "[GNUPG:] BADSIG CANARY\n"],
    ["count", valid.replace("[GNUPG:] GOODSIG", "ignored GOODSIG")],
    ["compliance", valid + "[GNUPG:] VERIFICATION_COMPLIANCE_MODE 8\n"],
    ["signer", valid.replace(policies[0][1], "A".repeat(40))],
    ["algorithm", valid.replace(" 4 0 1 10 ", " 4 0 17 10 ")],
    ["hash", valid.replace(" 1 10 00 ", " 1 8 00 ")],
    ["class", valid.replace(" 10 00 ", " 10 01 ")],
    ["time", valid.replace(String(created), String(now + 1))],
  ])("retains %s rejection without exposing the record", (substage, output) => {
    const entered: string[] = [];
    expect(() =>
      statusVerifier()("maven", output, now, (stage, family) => {
        entered.push(stage);
        expect(family).toBe("signature-policy");
      }),
    ).toThrow("integration.mockserver-material.bootstrap-gpg");
    expect(entered.at(-1)).toBe(`signature-${substage}`);
    expect(() => verifyBootstrapGpgStatus("maven", output, now)).toThrow(
      "integration.mockserver-material.bootstrap-gpg",
    );
    expect(entered.join(" ")).not.toContain("CANARY");
  });
  it("keeps actual success and failure when all optional writes fail", async () => {
    for (const output of [valid, valid.replace(" 1 10 00 ", " 1 8 00 ")]) {
      const markers: string[] = [];
      let calls = 0;
      const run = observedVerification({
        signature: statusVerifier(),
        write: (text) => {
          markers.push(text);
          throw new Error("optional-write");
        },
      });
      const result = run("maven", () =>
        Promise.resolve({
          stdout: ++calls === 5 ? output : Buffer.from("selected"),
        }),
      );
      if (output === valid) {
        await expect(result).resolves.toBeUndefined();
        expect(markers.at(-1)).toContain("stage=completed family=none");
      } else {
        await expect(result).rejects.toThrow(
          "integration.mockserver-material.bootstrap-gpg",
        );
        expect(markers.at(-1)).toContain(
          "stage=signature-hash family=signature-policy",
        );
      }
    }
  });
  it("retains the original signature/key validity rejection", async () => {
    const markers: string[] = [];
    const run = observedVerification({
      listing: () => ({ created: 3, expiry: 0 }),
      write: (text) => markers.push(text),
    });
    await expect(
      run("maven", () => Promise.resolve({ stdout: Buffer.from("selected") })),
    ).rejects.toThrow("integration.mockserver-material.bootstrap-gpg");
    expect(markers.at(-1)).toContain(
      "stage=signature-key-time family=signature-policy",
    );
  });
});

describe("optional stock-GPG verification compliance information", () => {
  const compliance = "[GNUPG:] VERIFICATION_COMPLIANCE_MODE 23\n";

  it.each(policies)(
    "accepts optional exact mode information without changing %s authority",
    (kind, fingerprint, hash, signatureClass) => {
      const valid = status(fingerprint, hash, signatureClass);
      expect(verifyBootstrapGpgStatus(kind, valid + compliance, now)).toEqual(
        verifyBootstrapGpgStatus(kind, valid, now),
      );
    },
  );

  it("rejects malformed, duplicate, substituted, early or detached information", () => {
    const [, fingerprint, hash, signatureClass] = policies[0];
    const valid = status(fingerprint, hash, signatureClass);
    for (const input of [
      compliance,
      compliance + valid,
      valid + compliance + compliance,
      valid + compliance.replace("23", "8"),
      valid + compliance.replace("23", "023"),
      valid + compliance.replace("23", "23 extra"),
      valid + compliance.replace(" 23", ""),
      valid.replace(fingerprint, "A".repeat(40)) + compliance,
      valid.replace(" 1 10 00 ", " 1 8 00 ") + compliance,
      valid + compliance + "[GNUPG:] BADSIG canary\n",
    ])
      expect(() => verifyBootstrapGpgStatus("maven", input, now)).toThrow(
        "integration.mockserver-material.bootstrap-gpg",
      );
  });
});

describe("bootstrap input type rejection before blocking I/O", () => {
  it("rejects an unwritten FIFO through the actual file authenticator", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-bootstrap-fifo-"));
    const fifo = resolve(root, "key");
    try {
      execFileSync("/usr/bin/mkfifo", [fifo], { env: {}, timeout: 1_000 });
      const module = new URL(
        "../mockserver-material/bootstrap-gpg.mjs",
        import.meta.url,
      ).href;
      const script = `import { authenticateBootstrapGpgInputForTesting } from ${JSON.stringify(module)};
        try { authenticateBootstrapGpgInputForTesting("node", "key", ${JSON.stringify(fifo)}); process.exitCode = 2; }
        catch (error) { if (error.message !== "integration.mockserver-material.bootstrap-gpg") process.exitCode = 3; }`;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          env: {},
          timeout: 1_000,
          killSignal: "SIGKILL",
          maxBuffer: 4_096,
          encoding: "utf8",
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("closed stock-GPG bootstrap records (synthetic, not cryptographic proof)", () => {
  it.each(policies)(
    "accepts exact %s signed record shape",
    (kind, fingerprint, hash, signatureClass) => {
      expect(
        verifyBootstrapGpgStatus(
          kind,
          status(fingerprint, hash, signatureClass),
          now,
        ),
      ).toEqual({
        primaryFingerprint: fingerprint,
        created,
        expiry: 0,
      });
      expect(
        verifyBootstrapGpgListing(kind, listing(fingerprint), now),
      ).toEqual({ created: created - 1, expiry: 0 });
    },
  );

  it.each([
    "BADSIG",
    "ERRSIG",
    "EXPKEYSIG",
    "EXPSIG",
    "REVKEYSIG",
    "KEYEXPIRED",
    "SIGEXPIRED",
    "NO_PUBKEY",
    "NODATA",
    "FAILURE",
    "UNEXPECTED",
  ])(
    "rejects additional %s status instead of accepting an earlier positive",
    (failure) => {
      const [, fingerprint, hash, signatureClass] = policies[0];
      expect(() =>
        verifyBootstrapGpgStatus(
          "maven",
          `${status(fingerprint, hash, signatureClass)}[GNUPG:] ${failure} canary\n`,
          now,
        ),
      ).toThrow("integration.mockserver-material.bootstrap-gpg");
    },
  );

  it("rejects duplicates, missing/mismatched signer, algorithm, class, time and malformed records", () => {
    const [, fingerprint, hash, signatureClass] = policies[1];
    const valid = status(fingerprint, hash, signatureClass);
    const invalid = [
      "",
      valid + valid,
      valid.replace(fingerprint, "A".repeat(40)),
      valid.replace(fingerprint.slice(-16), "A".repeat(16)),
      valid.replace(" 1 8 01 ", " 1 10 01 "),
      valid.replace(" 1 8 01 ", " 1 8 00 "),
      valid.replace(" 4 0 1 ", " 4 0 22 "),
      valid.replace(` ${created} 0 `, ` ${now + 1} 0 `),
      valid.replace(` ${created} 0 `, ` ${created} ${now} `),
      valid.replace(` ${created} 0 `, ` 0${created} 0 `),
      valid.replace("2023-11-14", "2023-11-15"),
      valid.replace(`${fingerprint}\n`, `${fingerprint} unexpected\n`),
      "x".repeat(16_385),
    ];
    for (const input of invalid)
      expect(() => verifyBootstrapGpgStatus("node", input, now)).toThrow(
        "integration.mockserver-material.bootstrap-gpg",
      );
  });

  it("rejects unselected, revoked, expired, future and nonsigning primary key listings", () => {
    const [, fingerprint] = policies[2];
    const valid = listing(fingerprint);
    for (const input of [
      "",
      valid + valid,
      valid.replace(fingerprint, "A".repeat(40)),
      valid.replace("pub:-:", "pub:r:"),
      valid.replace("pub:-:", "pub:e:"),
      valid.replace(":scSC:", ":cC:"),
      valid.replace(`:${created - 1}:0:`, `:${now + 1}:0:`),
      valid.replace(`:${created - 1}:0:`, `:${created - 1}:${now}:`),
    ])
      expect(() => verifyBootstrapGpgListing("jdk", input, now)).toThrow(
        "integration.mockserver-material.bootstrap-gpg",
      );
  });

  it("rejects hostile kinds and outputs without coercion", () => {
    let effects = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          effects += 1;
          throw new Error("canary");
        },
      },
    );
    expect(() =>
      verifyBootstrapGpgStatus(hostile as never, hostile as never, now),
    ).toThrow();
    expect(() =>
      verifyBootstrapGpgListing("jdk", hostile as never, now),
    ).toThrow();
    expect(effects).toBe(0);
  });
});
