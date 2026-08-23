# Rewrites a JSONC document as plain JSON on stdout: comments removed, a comma
# before a closing brace or bracket dropped, a leading byte-order mark dropped.
#
# Both editors read their managed document with a parser that accepts these
# (Zed through serde_json_lenient, VS Code through an `allowTrailingComma`
# visitor), so an operator may well have written them, while neither writer this
# installer uses will take them: jq refuses the file outright, and
# `ConvertFrom-Json` refuses it on the Windows PowerShell 5.1 baseline. Stripping
# first gives both halves the same plain document to merge, at the cost of the
# comments — the managed file is rewritten wholesale either way.
#
# Strings are walked rather than matched by pattern, because a value like a URL
# contains `//` legitimately. `LC_ALL=C` makes awk byte-oriented: under a UTF-8
# locale it dies with a multibyte conversion error on any non-ASCII byte outside
# a string, and a smart quote pasted out of a web page is exactly that.
_strip_jsonc() {
  LC_ALL=C awk '
    { doc = doc $0 "\n" }
    END {
      # A comma is held back until the next structural byte says whether it was
      # a separator or a trailing one, so `,` and `}` on separate lines are seen
      # together.
      pending = ""
      held = ""
      n = length(doc)
      for (i = 1; i <= n; i++) {
        c = substr(doc, i, 1)
        if (i == 1 && substr(doc, 1, 3) == "\357\273\277") { i = 3; continue }
        if (in_string) {
          out = out c
          if (escaped) { escaped = 0 }
          else if (c == "\\") { escaped = 1 }
          else if (c == "\"") { in_string = 0 }
          continue
        }
        if (c == "/" && (substr(doc, i + 1, 1) == "/" || substr(doc, i + 1, 1) == "*")) {
          if (substr(doc, i + 1, 1) == "/") {
            while (i <= n && substr(doc, i, 1) != "\n") { i++ }
            held = held "\n"
          } else {
            i = i + 2
            while (i < n && substr(doc, i, 2) != "*/") { i++ }
            i = i + 1
          }
          continue
        }
        if (pending != "") {
          if (c == " " || c == "\t" || c == "\r" || c == "\n") { held = held c; continue }
          # The comma was a trailing one, so only what stood between it and the
          # bracket is kept.
          out = out (c == "}" || c == "]" ? "" : pending) held
          pending = ""
          held = ""
        }
        if (c == ",") { pending = ","; continue }
        out = out c
        if (c == "\"") { in_string = 1 }
      }
      printf "%s%s%s", out, pending, held
    }
  ' "$1" 2>/dev/null
}

# Does this document carry a non-finite number? jq takes NaN and Infinity as
# extensions and rewrites them — to `null` and to `1.797e308` — so a file
# carrying one would have this half silently alter a value the run was not asked
# to touch, while the other half refuses it. Refused on both instead.
#
# Matched case-insensitively and on the short form, because jq takes all of nan,
# NAN, nAn, inf, Inf and INFINITY. Strings are walked, so a value that merely
# begins with those letters is ordinary text. Exits 0 when one is found.
# (No apostrophes in this program: it is a single-quoted shell word.)
_json_has_nonfinite() {
  LC_ALL=C awk '
    BEGIN { found = 0 }
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
        if (c == "N" || c == "n" || c == "I" || c == "i") {
          rest = tolower(substr($0, i))
          if (rest ~ /^nan/ || rest ~ /^inf/) { found = 1; exit }
        }
      }
      escaped = 0
    }
    END { exit (found ? 0 : 1) }
  '
}

# Copies a document to its backup path. A copy that fails part way leaves a
# truncated file beside the operator's own, which outlives a run that reported
# changing nothing and which a later rollback would hand back as their
# document — so the remains go before the failure is reported.
#
# `$3` selects mode preservation: the backup of a document that carries a
# credential is left owner-only under the installer's `umask 077`, while every
# other one is returned with the mode the operator gave it.
_back_up_managed_file() {
  if [ "$3" = "keep-mode" ]; then
    cp -p "$1" "$2" && return 0
  else
    cp "$1" "$2" && return 0
  fi
  rm -f "$2"
  out_error "could not back up $1"
  return 1
}

# The file a managed path ultimately names. chezmoi and stow both place a
# symlink where an editor expects its document, and renaming a staged file onto
# that path replaces the link itself: the operator's dotfile silently stops
# being what the editor reads, and their next change there has no effect.
# Resolving up front keeps the write, the backup, the mode, and the backup prune
# all acting on the real document. Mirrors Resolve-SetupManagedPath.
#
# Walked by hand rather than with `readlink -f` or `realpath`, neither of which
# BSD offers before macOS 12.3.
# Refs: https://github.com/apple-oss-distributions/file_cmds/blob/file_cmds-400/realpath/realpath.1
_resolve_managed_path() {
  _rmp_path=$1
  _rmp_hops=0
  while [ -L "$_rmp_path" ]; do
    _rmp_hops=$((_rmp_hops + 1))
    if [ "$_rmp_hops" -gt 40 ]; then
      out_error "$1 does not resolve to a file: too many symlink hops."
      return 1
    fi
    if ! _rmp_target=$(readlink "$_rmp_path"); then
      out_error "could not read the symlink at $_rmp_path"
      return 1
    fi
    case "$_rmp_target" in
      /*) _rmp_path=$_rmp_target ;;
      *) _rmp_path=${_rmp_path%/*}/$_rmp_target ;;
    esac
  done
  # `.` and `..` are collapsed textually, matching what GetFullPath does on the
  # PowerShell half, so the two report the same path and the backup prune —
  # which compares this against the directory listing — matches its own file.
  #
  # Textually, not through `cd -P`: resolving a symlinked ancestor would name a
  # directory the operator never typed, and would name a different one than the
  # PowerShell half, which does not resolve them either.
  # Anchored first: the collapse below rebuilds from the root, so a relative
  # path — which `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` all
  # accept — would come back pointing at the filesystem root while the
  # directory this run creates stays where the operator meant it.
  case $_rmp_path in
    /*) ;;
    *) _rmp_path="$PWD/$_rmp_path" ;;
  esac
  _rmp_out=''
  _rmp_rest=${_rmp_path#/}
  while [ -n "$_rmp_rest" ]; do
    _rmp_seg=${_rmp_rest%%/*}
    case "$_rmp_rest" in */*) _rmp_rest=${_rmp_rest#*/} ;; *) _rmp_rest='' ;; esac
    case "$_rmp_seg" in
      '' | .) ;;
      ..) _rmp_out=${_rmp_out%/*} ;;
      *) _rmp_out="$_rmp_out/$_rmp_seg" ;;
    esac
  done
  printf '%s' "${_rmp_out:-/}"
}

# A file's permission bits as an octal string, or empty when neither stat
# dialect answers. GNU takes `-c`, BSD takes `-f`; a caller that gets nothing
# leaves the mode alone rather than guessing one. This is the only mode source
# on BSD, where `chmod --reference` does not exist, so a run that lost it would
# widen the file it was asked to preserve.
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
    # `-e` alone follows the link, so a leftover pointing at nothing would be
    # skipped here and never removed; `-L` asks about the entry itself. The
    # PowerShell half enumerates the directory and sees both the same way.
    { [ -e "$_pmb_backup" ] || [ -L "$_pmb_backup" ]; } || continue
    [ "$_pmb_backup" = "$_pmb_keep" ] && continue
    if ! rm -f "$_pmb_backup"; then
      out_error "could not remove obsolete backup $_pmb_backup"
      return 1
    fi
  done
}
