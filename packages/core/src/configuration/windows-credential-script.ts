import { Buffer } from "node:buffer";

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AgentscopeCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref Credential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = false)]
  private static extern void CredFree(IntPtr credential);

  public static void Write(string target, byte[] secret) {
    IntPtr blob = Marshal.AllocHGlobal(secret.Length);
    try {
      Marshal.Copy(secret, 0, blob, secret.Length);
      Credential credential = new Credential {
        Type = 1,
        TargetName = target,
        Comment = "Agentscope credential",
        CredentialBlobSize = (UInt32)secret.Length,
        CredentialBlob = blob,
        Persist = 2,
        UserName = "Agentscope"
      };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int index = 0; index < secret.Length; index++) Marshal.WriteByte(blob, index, 0);
      Marshal.FreeHGlobal(blob);
      Array.Clear(secret, 0, secret.Length);
    }
  }

  public static byte[] Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] value = new byte[credential.CredentialBlobSize];
      if (value.Length > 0) Marshal.Copy(credential.CredentialBlob, value, 0, value.Length);
      return value;
    } finally {
      CredFree(pointer);
    }
  }

  public static void Exists(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      // Existence needs only the native record, never a managed secret copy.
    } finally {
      CredFree(pointer);
    }
  }

  public static void Delete(string target) {
    if (!CredDelete(target, 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@

function Write-Result([string] $value) {
  [Console]::Out.Write($value)
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -eq 'write') {
    [AgentscopeCredentialManager]::Write($request.target, [Convert]::FromBase64String($request.secretBase64))
    Write-Result '{"ok":true}'
  } elseif ($request.operation -eq 'read') {
    $value = [AgentscopeCredentialManager]::Read($request.target)
    try {
      Write-Result ('{"ok":true,"secretBase64":"' + [Convert]::ToBase64String($value) + '"}')
    } finally {
      [Array]::Clear($value, 0, $value.Length)
    }
  } elseif ($request.operation -eq 'exists') {
    [AgentscopeCredentialManager]::Exists($request.target)
    Write-Result '{"ok":true}'
  } elseif ($request.operation -eq 'delete') {
    [AgentscopeCredentialManager]::Delete($request.target)
    Write-Result '{"ok":true}'
  } else {
    Write-Result '{"ok":false,"code":"malformed"}'
  }
} catch [System.ComponentModel.Win32Exception] {
  $code = switch ($_.Exception.NativeErrorCode) {
    1168 { 'missing' }
    1312 { 'locked' }
    5 { 'denied' }
    1223 { 'denied' }
    default { 'unavailable' }
  }
  Write-Result ('{"ok":false,"code":"' + $code + '"}')
} catch {
  Write-Result '{"ok":false,"code":"malformed"}'
}
`;

export const WINDOWS_CREDENTIAL_MANAGER_ARGUMENTS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64"),
]);
