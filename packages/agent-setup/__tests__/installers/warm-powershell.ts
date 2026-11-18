import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each installer case runs a fresh `pwsh -Command` or `-File`, and a
// short-lived pwsh never saves its module analysis cache: a background task
// writes it 10 s after the last change, so every such process analyzes
// PSModulePath again.
// https://github.com/PowerShell/PowerShell/issues/28375
// GitHub's Ubuntu image puts 155 modules on that path (Az, Microsoft.Graph,
// Pester, ...), so on a busy runner the installer suites' pwsh cases took
// 3.2 s at the median and past the 10 s spawn watchdog at the tail; with a
// cache they take 1.2 s and at most 3.8 s under the same load. CI lost a
// case to that watchdog about once in a hundred runs.
//
// One session stays alive until it has written the cache to a fresh location,
// which the test workers, spawned after this setup, inherit through the
// environment. It touches the cmdlets the installer fragments rely on, so
// their modules are part of the analysis it saves.
// https://github.com/PowerShell/PowerShell/blob/v7.6.0/src/System.Management.Automation/engine/Modules/AnalysisCache.cs#L665-L694
const WARM = `
$null = Join-Path ([IO.Path]::GetTempPath()) x | Test-Path
$null = @{ a = 1 } | ConvertTo-Json | ConvertFrom-Json
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (-not (Test-Path -LiteralPath $env:PSModuleAnalysisCachePath)) {
  if ([DateTime]::UtcNow -gt $deadline) { throw "pwsh did not write $env:PSModuleAnalysisCachePath" }
  Start-Sleep -Milliseconds 250
}
`;

export default function setup(): (() => void) | undefined {
  if (spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0) return undefined;
  const directory = mkdtempSync(join(tmpdir(), 'floway-pwsh-'));
  process.env.PSModuleAnalysisCachePath = join(directory, 'ModuleAnalysisCache');
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', WARM], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`warming pwsh failed: ${result.stdout}${result.stderr}`, { cause: result.error });
  return () => rmSync(directory, { recursive: true, force: true });
}
