# Floway agent setup installer (POSIX shell).
#
# Fixed, checked-in body. The language-native assignment prefix (the FLOWAY_*
# variables and a trace-suppressing `set +x`) is prepended per request by the
# gateway, so this file starts straight at the installer logic with no shebang.
# The phase markers below are the seams Tasks 7/8 fill in; until then the body
# is a valid no-op skeleton so an early `curl ... | sh` does nothing harmful.

set -eu

# --- phase: preflight ---
# --- phase: claude-code ---
# --- phase: codex ---
# --- phase: verify ---

echo 'Floway agent setup is not implemented in this build yet.' >&2
