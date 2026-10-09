# Rollback retains a backup when restoration fails so manual recovery remains
# possible. Callers keep separate transaction boundaries and aggregate failures.
_restore_managed_file() {
  _rmf_existed=$1
  _rmf_backup=$2
  _rmf_path=$3
  _rmf_original_label=$4
  _rmf_created_label=$5
  if [ "$_rmf_existed" -eq 1 ]; then
    if [ -n "$_rmf_backup" ] && [ -e "$_rmf_backup" ] && ! mv "$_rmf_backup" "$_rmf_path" 2>/dev/null; then
      out_warn "could not restore $_rmf_path from its backup; your original $_rmf_original_label is preserved at $_rmf_backup — restore it by hand."
      return 1
    fi
  elif ! rm -f "$_rmf_path" 2>/dev/null; then
    out_warn "could not remove the $_rmf_created_label this run created at $_rmf_path — remove it by hand."
    return 1
  fi
  return 0
}

_prune_managed_backups() {
  _pmb_path=$1
  _pmb_keep=$2
  for _pmb_backup in "$_pmb_path".floway-backup.*; do
    [ -e "$_pmb_backup" ] || continue
    [ "$_pmb_backup" = "$_pmb_keep" ] && continue
    if ! rm -f "$_pmb_backup"; then
      out_error "could not remove obsolete backup $_pmb_backup"
      return 1
    fi
  done
}

_stage_provider_connections() {
  local existing=$1 stage=$2 provider=$3 include_key=$4 old=/dev/null
  ensure_jq || return 1
  if [ -f "$existing" ]; then old=$existing; fi
  (umask 077 && : > "$stage") || return 1
  chmod 600 "$stage" || return 1
  FLOWAY_CONNECTION_KEY="$SETUP_API_KEY" "$JQ" -en --rawfile old "$old" --arg provider "$provider" --arg endpoint "${SETUP_ENDPOINT%/}" --argjson includeKey "$include_key" '
    ($old | if length == 0 then {connections: []} else fromjson end)
    | .connections = ((.connections | arrays | map(select(.provider != $provider))) +
      [{provider: $provider, endpoint: $endpoint} + (if $includeKey then {apiKey: env.FLOWAY_CONNECTION_KEY} else {} end)])
  ' > "$stage" 2> "$SETUP_TMPDIR/provider-parse.err" || {
    out_error 'could not update the Floway connection configuration'
    return 1
  }
}
