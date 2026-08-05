// Bash privileged mode ignores BASH_ENV and exported shell functions. The
// PowerShell command resolves an application under PSHOME without command
// lookup, starts it without profiles, and sends the secret-bearing script over
// UTF-8 stdin rather than argv. Both close the execution boundary before a
// downloaded installer assigns any secret.
// https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html
// https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_command_precedence
// https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_pwsh
const powerShellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const windowsAgentSetupCommand = (origin: string, path: string): string => {
  const endpoint = powerShellLiteral(origin);
  const childEndpointAssignment = powerShellLiteral(`$SetupEndpoint = ${endpoint}`);
  const scriptUri = `($SetupEndpoint + ${powerShellLiteral(path)})`;
  return `& { $SetupEndpoint = ${endpoint}; $PowerShell = $null; foreach ($Name in @('pwsh.exe', 'pwsh', 'powershell.exe')) { $Candidate = [System.IO.Path]::Combine($PSHOME, $Name); if ([System.IO.File]::Exists($Candidate)) { $PowerShell = $Candidate; break } }; if (-not $PowerShell) { throw 'Unable to locate a PowerShell application under $PSHOME.' }; $PreviousOutputEncoding = $OutputEncoding; try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(${childEndpointAssignment}, (Microsoft.PowerShell.Utility\\Invoke-RestMethod -Uri ${scriptUri})) | & $PowerShell -NoProfile -NonInteractive -Command - } finally { $OutputEncoding = $PreviousOutputEncoding } }`;
};

export const agentSetupCommand = (origin: string, path: string, platform: 'unix' | 'windows'): string => platform === 'unix'
  ? `export SETUP_ENDPOINT='${origin.replaceAll("'", "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT${path}" | bash -p`
  : windowsAgentSetupCommand(origin, path);
