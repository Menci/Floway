# The lock directory lives beside the files it protects, so Bash and PowerShell
# serialize the same target even when HOME differs or a config-root override is
# used. mkdir is the one exclusive-create primitive available on the Bash 3.2
# and PowerShell 5.1 baselines. A bounded wait fails safely on a lock left by an
# uncatchable process death; automatically breaking it cannot be made atomic
# across both runtimes.
SETUP_LOCK_PATH=""
SETUP_LOCK_OWNER=""
SETUP_LOCK_ACQUIRED=0

_acquire_setup_lock() {
  _asl_root=$1
  _asl_timeout=600
  _asl_started=$(date +%s)
  if ! mkdir -p "$_asl_root"; then
    out_error "could not create $_asl_root"
    return 1
  fi
  _asl_path="$_asl_root/.floway-agent-setup.lock"

  while ! mkdir "$_asl_path" 2>/dev/null; do
    _asl_now=$(date +%s)
    if [ $((_asl_now - _asl_started)) -ge "$_asl_timeout" ]; then
      out_error "another Agent Setup invocation is using $_asl_root; if no setup process is running, remove the stale lock at $_asl_path and re-run."
      return 1
    fi
    sleep 0.1
  done

  chmod 700 "$_asl_path" 2>/dev/null || true
  _asl_owner="$$:$SETUP_TMPDIR"
  _asl_owner_file="$_asl_path/owner"
  if ! printf '%s\n' "$_asl_owner" > "$_asl_owner_file"; then
    rm -f "$_asl_owner_file" 2>/dev/null || true
    rmdir "$_asl_path" 2>/dev/null || true
    out_error "could not initialize the Agent Setup lock at $_asl_path"
    return 1
  fi
  chmod 600 "$_asl_owner_file" 2>/dev/null || true

  SETUP_LOCK_PATH=$_asl_path
  SETUP_LOCK_OWNER=$_asl_owner
  SETUP_LOCK_ACQUIRED=1
}

_release_setup_lock() {
  [ "$SETUP_LOCK_ACQUIRED" -eq 1 ] || return 0
  _rsl_owner_file="$SETUP_LOCK_PATH/owner"
  _rsl_owner=""
  if [ -f "$_rsl_owner_file" ]; then
    _rsl_owner=$(cat "$_rsl_owner_file" 2>/dev/null || true)
  fi
  if [ "$_rsl_owner" != "$SETUP_LOCK_OWNER" ]; then
    out_warn "could not release the Agent Setup lock at $SETUP_LOCK_PATH because its owner changed."
  elif ! rm -f "$_rsl_owner_file" 2>/dev/null || ! rmdir "$SETUP_LOCK_PATH" 2>/dev/null; then
    out_warn "could not release the Agent Setup lock at $SETUP_LOCK_PATH; remove it after confirming no setup process is running."
  fi
  SETUP_LOCK_PATH=""
  SETUP_LOCK_OWNER=""
  SETUP_LOCK_ACQUIRED=0
}
