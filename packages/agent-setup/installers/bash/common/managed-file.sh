# Does this JSON file carry a `//` or `/*` comment outside a string? Both
# editors read their managed document with a JSONC-tolerant parser, so a comment
# is the operator's content — but jq has no JSONC mode and would refuse the file
# while naming the wrong cause. Strings are walked rather than matched by
# pattern, because a value like a URL contains `//` legitimately. Mirrors
# Test-SetupJsonHasComment on the PowerShell side.
_json_has_comment() {
  awk '
    BEGIN { in_string = 0; escaped = 0; found = 0 }
    {
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (in_string) {
          if (escaped) { escaped = 0 }
          else if (c == "\\") { escaped = 1 }
          else if (c == "\"") { in_string = 0 }
          continue
        }
        if (c == "\"") { in_string = 1; continue }
        if (c == "/") {
          n = substr($0, i + 1, 1)
          if (n == "/" || n == "*") { found = 1; exit }
        }
      }
      escaped = 0
    }
    # `exit` runs END, so the verdict travels in a flag rather than in the exit
    # status of the rule body, which END would otherwise overwrite.
    END { exit (found ? 0 : 1) }
  ' "$1" 2>/dev/null
}

# A file's permission bits as an octal string, or empty when neither stat
# dialect answers. GNU takes `-c`, BSD takes `-f`; a caller that gets nothing
# leaves the mode alone rather than guessing one.
_stat_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || printf ''
}

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
