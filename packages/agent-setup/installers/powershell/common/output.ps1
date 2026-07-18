# Floway Agent Setup common installer fragment (PowerShell). TypeScript prepends
# the language-native assignment prefix and appends one agent fragment.
#
# Each served script targets exactly one agent and rolls back that agent's
# configuration as one transaction on failure.

# --- output layer -----------------------------------------------------------
#
# Setup-owned output follows Homebrew's compact visual language: blue `==>`
# notices introduce major phases, while warnings and errors color only their
# labels. Phase details remain subordinate instead of competing for attention.
# Native package managers inherit the terminal directly, preserving their ANSI
# colors, carriage-return progress, buffering, and cursor behavior.
#
# stdout color rides the host: `Write-Host -ForegroundColor` colors an
# interactive console yet writes no escape sequences when redirected/captured,
# so it is the correct stdout mechanism on both Windows PowerShell 5.1 and
# PowerShell 7. stderr goes through [Console]::Error, colored with ANSI only for
# an interactive error stream with NO_COLOR unset — a redirected capture stays
# escape-free. UTF-8 output keeps the status glyphs portable to 5.1.
function Write-SetupHostLine {
  param([string]$Text, [System.ConsoleColor]$Color, [switch]$Plain)
  if ($Plain -or $script:SetupNoColor) { Write-Host $Text } else { Write-Host $Text -ForegroundColor $Color }
}

function Write-SetupNotice {
  param([string]$Text)
  if ($script:SetupNoColor) { Write-Host "==> $Text"; return }
  if ($script:SetupOutAnsi) {
    Write-Host "$($script:SetupEsc)[34m==>$($script:SetupEsc)[0m $($script:SetupEsc)[1m$Text$($script:SetupEsc)[0m"
    return
  }
  Write-Host '==>' -ForegroundColor Blue -NoNewline
  Write-Host " $Text" -ForegroundColor White
}

# Console.Error is used directly so diagnostics remain on stderr while only the
# Homebrew-style label receives color.
function Write-SetupDiagnostic {
  param([string]$Label, [string]$Text, [System.ConsoleColor]$Color, [string]$TestAnsiCode)
  if ($script:SetupErrColor) {
    $previous = [Console]::ForegroundColor
    try {
      [Console]::ForegroundColor = $Color
      [Console]::Error.Write("${Label}:")
      [Console]::ForegroundColor = $previous
      [Console]::Error.WriteLine(" $Text")
    } finally {
      [Console]::ForegroundColor = $previous
    }
  } elseif ($script:SetupForceColor -and (-not $script:SetupNoColor)) {
    [Console]::Error.WriteLine("$($script:SetupEsc)[${TestAnsiCode}m${Label}:$($script:SetupEsc)[0m $Text")
  } else {
    [Console]::Error.WriteLine("${Label}: $Text")
  }
}

function Write-SetupAgentNotice { param([string]$Label, [string]$AgentName) Write-SetupNotice "${Label}: $AgentName" }
function Write-SetupMetadata { param([string]$Label, [string]$Value) Write-Host "${Label}: $Value" }
function Write-SetupInfo { param([string]$Text) Write-SetupHostLine $Text -Plain }
function Write-SetupWarn { param([string]$Text) Write-SetupDiagnostic 'Warning' $Text Yellow '93' }
function Write-SetupError { param([string]$Text) Write-SetupDiagnostic 'Error' $Text Red '91' }

# Report a primary error to stderr and unwind. The agent boundary recognizes the
# 'setup-handled' marker as already reported, so no line is ever duplicated.
function Stop-Setup { param([string]$Message) Write-SetupError $Message; throw 'setup-handled' }
