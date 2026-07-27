# Terminate a process and its descendants. PowerShell 7's runtime exposes the
# tree-aware Kill(bool) overload; Windows PowerShell 5.1 uses taskkill /T.
function Stop-SetupProcessTree {
  param([System.Diagnostics.Process]$Process)
  $runningOnWindows = Test-SetupIsWindows
  if ($runningOnWindows) {
    & taskkill.exe /PID $Process.Id /T /F *> $null
    if ($LASTEXITCODE -ne 0 -and (-not $Process.HasExited)) {
      Stop-Setup "taskkill could not terminate process tree $($Process.Id)."
    }
    return
  }
  try {
    $Process.Kill($true)
  } catch {
    if (-not $Process.HasExited) { Stop-Setup "could not terminate process tree $($Process.Id)." }
  }
}

# Run a fixed package-manager command with inherited stdout/stderr. The child
# remains attached to the real terminal, so progress updates and ANSI control
# sequences render in real time without a lossy line-prefix filter.
function Invoke-SetupLiveProcess {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start $Exe." }
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup "$Exe timed out after $TimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) { Stop-Setup "$Exe exited with status $($process.ExitCode)." }
}

# Run a child process with captured output under a deadline, terminating its
# whole process tree and throwing on timeout.
function Invoke-SetupProcess {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$TimeoutMessage)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # ArgumentList is unavailable in Windows PowerShell 5.1. These arguments are
  # fixed internal tokens, so quoting them with ProcessStartInfo.Arguments is
  # safe and keeps external input out of the child command line.
  $startInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start $Exe." }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup $(if ($TimeoutMessage) { $TimeoutMessage } else { "$Exe timed out after $TimeoutSeconds seconds." })
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  [PSCustomObject]@{ ExitCode = $process.ExitCode; Output = ($stdout + $stderr) }
}
