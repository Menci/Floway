# Floway agent setup installer (PowerShell).
#
# Fixed, checked-in body. The language-native assignment prefix (the $Floway*
# variables and a trace-suppressing `Set-PSDebug -Off`) is prepended per
# request by the gateway, so this file starts straight at the installer logic.
# The phase markers below are the seams Tasks 7/8 fill in; until then the body
# is a valid no-op skeleton so an early `irm ... | iex` does nothing harmful.

$ErrorActionPreference = 'Stop'

# --- phase: preflight ---
# --- phase: claude-code ---
# --- phase: codex ---
# --- phase: verify ---

Write-Host 'Floway agent setup is not implemented in this build yet.'
