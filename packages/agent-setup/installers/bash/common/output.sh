# Floway Agent Setup common installer fragment (Bash 3.2+). TypeScript prepends
# the language-native assignment prefix and appends one agent fragment.
#
# Each served script targets exactly one agent. Errexit stays disabled because
# Bash suppresses it inside guarded calls; failures are checked explicitly and
# the selected agent's configuration is rolled back as one transaction.

# --- output layer -----------------------------------------------------------
#
# Setup-owned output follows Homebrew's compact visual language: blue `==>`
# notices introduce major phases, while warnings and errors color only their
# labels. Phase details remain subordinate instead of competing for attention.
# Native package managers inherit the terminal directly, so their ANSI colors,
# carriage-return progress, buffering, and cursor behavior remain intact.
#
# Color is emitted only for an interactive terminal with NO_COLOR unset, probed
# per stream so a redirected capture on either stdout or stderr stays free of
# escape sequences. Agent notices and informational lines go to stdout;
# warnings, errors, and rollback notices go to stderr.
_stream_color() {
  [ -z "${NO_COLOR:-}" ] || return 1
  [ -n "${AGENT_SETUP_TEST_FORCE_COLOR:-}" ] && return 0
  [ -t "$1" ]
}
_init_output() {
  if _stream_color 1; then _OUT_COLOR=1; else _OUT_COLOR=0; fi
  if _stream_color 2; then _ERR_COLOR=1; else _ERR_COLOR=0; fi
  _C_BLUE=$'\033[34m'
  _C_BOLD=$'\033[1m'
  _C_YELLOW=$'\033[93m'
  _C_RED=$'\033[91m'
  _C_RESET=$'\033[0m'
}

_emit_notice() {
  if [ "$_OUT_COLOR" -eq 1 ]; then
    printf '%s==>%s %s%s%s\n' "$_C_BLUE" "$_C_RESET" "$_C_BOLD" "$1" "$_C_RESET"
  else
    printf '==> %s\n' "$1"
  fi
}

# Homebrew colors the diagnostic label rather than the whole message, keeping
# paths and remediation text readable in the terminal's native foreground.
_emit_diagnostic() {
  if [ "$_ERR_COLOR" -eq 1 ]; then
    printf '%s%s:%s %s\n' "$1" "$2" "$_C_RESET" "$3" >&2
  else
    printf '%s: %s\n' "$2" "$3" >&2
  fi
}

# Default-color detail lines stay uncolored rather than carrying a bare reset.
# $1 stream (1|2), $2 color, $3 text.
_emit_line() {
  if [ "$1" -eq 1 ]; then
    if [ "$_OUT_COLOR" -eq 1 ] && [ -n "$2" ]; then printf '%s%s%s\n' "$2" "$3" "$_C_RESET"; else printf '%s\n' "$3"; fi
  else
    if [ "$_ERR_COLOR" -eq 1 ] && [ -n "$2" ]; then printf '%s%s%s\n' "$2" "$3" "$_C_RESET" >&2; else printf '%s\n' "$3" >&2; fi
  fi
}

out_agent_notice() { _emit_notice "$1: $2"; }
out_metadata() { _emit_line 1 '' "$1: $2"; }
out_info() { _emit_line 1 '' "$1"; }
out_warn() { _emit_diagnostic "$_C_YELLOW" 'Warning' "$1"; }
out_error() { _emit_diagnostic "$_C_RED" 'Error' "$1"; }

SETUP_TMPDIR=""
_cleanup() {
  if [ -n "$SETUP_TMPDIR" ]; then
    rm -rf "$SETUP_TMPDIR" 2>/dev/null || true
  fi
}
# EXIT owns cleanup. INT/TERM only translate the signal into the conventional
# exit status (130 = 128+SIGINT, 143 = 128+SIGTERM) and let that exit fire the
# EXIT trap. Cleaning up directly inside the INT/TERM handlers would delete the
# working directory and then let the interrupted script resume into the next
# agent's configuration; exiting instead stops all further agent work.
