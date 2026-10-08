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

_merge_provider_extension() {
  local existing=$1 stage=$2 header merged
  ensure_jq || return 1
  header="$SETUP_TMPDIR/provider-connections.json"
  merged="$SETUP_TMPDIR/provider-extension.js"
  if ! "$JQ" -Rsc '
    def connections:
      split("\n") | .[1] | capture("^const connections = (?<json>.*);$").json | fromjson
      | if type != "array" or length == 0 then error("invalid Floway connections") else . end
      | if all(.[]; type == "object" and (.provider | type == "string" and test("^[a-z0-9][a-z0-9._-]{0,63}$")) and (.endpoint | type == "string") and (.apiKey | type == "string"))
        and (map(.provider) | length == (unique | length)) then . else error("invalid Floway connection") end;
    connections
  ' "$stage" > "$header" 2> "$SETUP_TMPDIR/provider-parse.err"; then
    out_error 'the extension has an invalid provider configuration'
    return 1
  fi
  if [ -f "$existing" ]; then
    if ! "$JQ" -Rsc 'split("\n") | .[1] | capture("^const connections = (?<json>.*);$").json | fromjson' "$existing" > "$SETUP_TMPDIR/existing-connections.json" 2> "$SETUP_TMPDIR/provider-parse.err"; then
      out_error 'the installed extension has an invalid provider configuration'
      return 1
    fi
    if ! "$JQ" -c -s '
      if all(.[]; type == "array" and length > 0 and all(.[]; type == "object" and (.provider | type == "string" and test("^[a-z0-9][a-z0-9._-]{0,63}$")) and (.endpoint | type == "string") and (.apiKey | type == "string")) and (map(.provider) | length == (unique | length)))
      then reduce .[][] as $connection ([]; map(select(.provider != $connection.provider)) + [$connection])
      else error("invalid Floway connections") end
    ' "$SETUP_TMPDIR/existing-connections.json" "$header" > "$SETUP_TMPDIR/merged-connections.json" 2> "$SETUP_TMPDIR/provider-parse.err"; then
      out_error 'could not merge installed provider configurations'
      return 1
    fi
    header="$SETUP_TMPDIR/merged-connections.json"
  fi
  {
    printf '%s\n' '// Managed by Floway Agent Setup.'
    printf 'const connections = '
    tr -d '\n' < "$header"
    printf ';\n'
    awk 'NR > 2' "$stage"
  } > "$merged" || return 1
  chmod 600 "$merged" || return 1
  mv "$merged" "$stage"
}
