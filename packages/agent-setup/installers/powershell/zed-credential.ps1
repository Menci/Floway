# The C# body that writes Zed's Windows credential, in the one place both the
# installer and the dashboard's pasted snippet read it from. Two copies would
# be worse than a duplicate: both guard on `FlowayZedCredential` already being
# in the AppDomain, so in a console where one ran first the other silently gets
# its version — a snippet that differed by so much as where it zeroes the blob
# would disable the installer's scrubbing without any sign of it.
#
# --- csharp
$SetupZedCredWriteSource = @'
using System;
using System.Runtime.InteropServices;

public static class FlowayZedCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);

  public static void Write(string targetName, string userName, byte[] secret) {
    IntPtr blob = Marshal.AllocHGlobal(secret.Length);
    try {
      Marshal.Copy(secret, 0, blob, secret.Length);
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = 1;              // CRED_TYPE_GENERIC
      credential.TargetName = targetName;
      credential.CredentialBlobSize = (uint)secret.Length;
      credential.CredentialBlob = blob;
      credential.Persist = 2;           // CRED_PERSIST_LOCAL_MACHINE
      credential.UserName = userName;
      if (!CredWriteW(ref credential, 0)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      for (int i = 0; i < secret.Length; i++) { Marshal.WriteByte(blob, i, 0); }
      Marshal.FreeHGlobal(blob);
    }
  }
}
'@
# --- csharp end
