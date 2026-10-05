import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
