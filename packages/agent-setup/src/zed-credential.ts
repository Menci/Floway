import { SETUP_POWERSHELL_COMMON_ZED_CREDENTIAL } from './script-assets.generated.ts';

// The C# body the installer compiles to write Zed's Windows credential, lifted
// out of the PowerShell fragment that carries it.
//
// The dashboard's pasted snippet emits this same text rather than a copy of it,
// and the sharing is load-bearing rather than tidiness: both the snippet and
// the installer guard on `FlowayZedCredential` already being in the AppDomain,
// so in a console where one has run the other silently uses whichever version
// got there first. A snippet that differed by where it zeroes the freed blob
// would disable the installer's scrubbing with nothing to show for it.
//
// Bounded by the markers in the fragment, and a miss throws rather than
// yielding a partial program: `Add-Type` would fail at the operator's machine
// with a compiler error naming nothing they can act on.
const OPEN = '# --- csharp\n$SetupZedCredWriteSource = @\'\n';
const CLOSE = '\'@\n# --- csharp end';

const between = (source: string): string => {
  const start = source.indexOf(OPEN);
  const end = source.indexOf(CLOSE, start);
  if (start === -1 || end === -1) throw new Error('the Zed credential fragment no longer carries its C# markers');
  return source.slice(start + OPEN.length, end);
};

export const ZED_CREDENTIAL_CSHARP = between(SETUP_POWERSHELL_COMMON_ZED_CREDENTIAL);
