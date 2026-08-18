import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { WINDOWS_CREDENTIAL_MANAGER_ARGUMENTS } from "./windows-credential-script.js";

describe("Windows Credential Manager native script", () => {
  it("pins the Unicode P/Invoke boundary, fixed failures, and memory clearing", () => {
    const encoded = WINDOWS_CREDENTIAL_MANAGER_ARGUMENTS.at(-1);
    expect(encoded).toBeDefined();
    const script = Buffer.from(encoded!, "base64").toString("utf16le");
    for (const value of [
      "CredWriteW",
      "CredReadW",
      "CredDeleteW",
      "CharSet.Unicode",
      "1168 { 'missing' }",
      "1312 { 'locked' }",
      "5 { 'denied' }",
      "1223 { 'denied' }",
      "Array.Clear",
      "Marshal.WriteByte",
      "public static void Exists",
      "[AgentscopeCredentialManager]::Exists($request.target)",
    ])
      expect(script).toContain(value);
    expect(script).not.toContain(
      "[void] [AgentscopeCredentialManager]::Read($request.target)",
    );
    expect(script).not.toContain("cmdkey");
    expect(WINDOWS_CREDENTIAL_MANAGER_ARGUMENTS).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ]);
  });
});
