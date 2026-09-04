# Shared harness-converter helpers for the oh-my-pi, VSCode, Zed, and opencode
# Agent Setup fragments. Each target is configured by a Python converter served
# by this gateway that turns the /v1/models payload into editor-specific
# settings; these helpers fetch the model list, download the converter, and run
# it. The converter never sees the API key — the fetch carries it, and python3
# runs with the credential unset.

# A private working directory per run, created on first use and removed by the
# caller's finally block. Lives under the system temp so a crashed run leaves no
# trace in the user's config directories.
function Get-SetupHarnessTmpDir {
  if (-not $script:SetupHarnessTmpDir) {
    $script:SetupHarnessTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('floway-agent-setup.' + $PID)
    New-Item -ItemType Directory -Path $script:SetupHarnessTmpDir -Force | Out-Null
  }
  return $script:SetupHarnessTmpDir
}

function Remove-SetupHarnessTmpDir {
  if ($script:SetupHarnessTmpDir -and (Test-Path -LiteralPath $script:SetupHarnessTmpDir)) {
    Remove-Item -LiteralPath $script:SetupHarnessTmpDir -Recurse -Force -ErrorAction SilentlyContinue
    $script:SetupHarnessTmpDir = $null
  }
}

function Get-SetupHarnessPython {
  $python = Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $python) {
    Stop-Setup 'python3 is required to convert the Floway model list into editor settings.'
  }
  return $python.Source
}

# Downloads the served converter into the private working directory; it carries
# no secret, so the download needs no bearer header.
function Get-SetupHarnessConverter {
  param([string]$Name)
  $uri = "$SetupEndpoint/api/setup/harness/$Name.py"
  $destination = Join-Path (Get-SetupHarnessTmpDir) "floway-to-$Name.py"
  try {
    Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 120 -OutFile $destination
  } catch {
    Stop-Setup "could not download the converter from $uri."
  }
  return $destination
}

# Fetches the Floway model list with the embedded API key. The key travels in
# the Authorization header only, so it never reaches argv or the converter.
function Get-SetupHarnessModels {
  $uri = "$SetupEndpoint/v1/models"
  $destination = Join-Path (Get-SetupHarnessTmpDir) 'models.json'
  try {
    Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 120 -Headers @{ Authorization = "Bearer $SetupApiKey" } -OutFile $destination
  } catch {
    Stop-Setup 'could not fetch the Floway model list.'
  }
  return $destination
}

# Runs the converter over the fetched models and returns the converted settings
# as a string.
function Invoke-SetupHarnessConverter {
  param([string]$Name, [string]$Converter, [string]$Models)
  $python = Get-SetupHarnessPython
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $python
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.Arguments = ('"' + $Converter.Replace('"', '\"') + '" "Floway" "' + ($SetupEndpoint + '/v1').Replace('"', '\"') + '"')
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup 'failed to start the Python converter.' }
  $models = Get-Content -Raw -LiteralPath $Models
  $process.StandardInput.Write($models)
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup 'the Python converter timed out.'
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { Stop-Setup ("the Python converter failed: " + $stderr.Trim()) }
  return $stdout
}
