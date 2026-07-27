# Run a command under a wall-clock limit. macOS ships no `timeout`, so the
# Bash-3.2 fallback enables job control for one launch, placing the command and
# all ordinary descendants in a dedicated process group. The watchdog signals
# that group with TERM then KILL, retains its process-group id across root exit,
# and the parent waits for escalation to finish before returning 124.
_run_with_timeout() {
  _rwt_secs=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$_rwt_secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$_rwt_secs" "$@"
    return $?
  fi

  _rwt_marker=$(mktemp "$SETUP_TMPDIR/timeout.XXXXXX") || return 1
  rm -f "$_rwt_marker"
  if [ -n "${AGENT_SETUP_TEST_TRACE_TIMEOUT:-}" ]; then
    printf 'Agent Setup test: timeout fallback: process-tree\n'
  fi
  set -m
  "$@" &
  _rwt_pid=$!
  set +m
  (
    # The watchdog must not retain the installer's stdout/stderr descriptors
    # after its parent shell is killed; otherwise a pipe consumer waits for the
    # orphaned sleep to exit before receiving EOF.
    exec </dev/null >/dev/null 2>&1
    sleep "$_rwt_secs"
    if kill -0 "$_rwt_pid" 2>/dev/null; then
      : > "$_rwt_marker"
      kill -TERM -- "-$_rwt_pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$_rwt_pid" 2>/dev/null || true
    fi
  ) &
  _rwt_watchdog=$!
  wait "$_rwt_pid"
  _rwt_status=$?
  if [ -e "$_rwt_marker" ]; then
    # Let TERM→KILL escalation finish before reporting the timeout.
    wait "$_rwt_watchdog" 2>/dev/null || true
    rm -f "$_rwt_marker"
    return 124
  fi
  kill "$_rwt_watchdog" 2>/dev/null || true
  wait "$_rwt_watchdog" 2>/dev/null || true
  rm -f "$_rwt_marker"
  return $_rwt_status
}
