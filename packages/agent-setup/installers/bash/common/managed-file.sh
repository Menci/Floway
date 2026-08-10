# Does this JSON file use a JSONC construct — a `//` or `/*` comment, or a
# comma before a closing brace or bracket? Both editors read their managed
# document with a parser that accepts these (Zed's serde_json_lenient, VS Code's
# `allowTrailingComma` visitor), so they are the operator's content, but jq has
# no lenient mode and would refuse the file while naming the wrong cause.
#
# PowerShell 6+ accepts a trailing comma and would have gone on to rewrite the
# file without it — 5.1 refuses it itself — so refusing is also what keeps the
# two halves from reaching opposite verdicts on one document, on either host. Strings are walked rather than
# matched by pattern, because a value like a URL contains `//` legitimately.
# Exits 0 for a JSONC construct, 2 for a value jq would rewrite rather than
# refuse, and 1 for a document neither applies to.
#
# Mirrors the `jsonc` arm of Get-SetupJsonVerdict, down to the
# whitespace it skips: space, tab and CR here, plus the newline there, which
# awk never sees because it splits records on it. Anything wider — a form feed,
# a non-breaking space — would have the two halves refuse one document under
# two different names. That function has a second arm this one does not: jq
# decides what is valid JSON for this half, so there is nothing here to mirror
# the strict verdict PowerShell has to reach by hand.
_json_has_jsonc_syntax() {
  awk '
    BEGIN { in_string = 0; escaped = 0; found = 0; comma = 0; bad = 0 }
    {
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (in_string) {
          if (escaped) { escaped = 0 }
          else if (c == "\\") { escaped = 1 }
          else if (c == "\"") { in_string = 0 }
          continue
        }
        if (c == "/") {
          n = substr($0, i + 1, 1)
          if (n == "/" || n == "*") { found = 1; exit }
        }
        # A comma survives across lines, because `,\n}` is how a trailing comma
        # is usually written.
        # jq takes NaN and Infinity as extensions and rewrites them, to null
        # and to 1.797e308, so accepting such a document here would have this
        # half silently alter a value inside a foreign entry while the
        # PowerShell half refuses the file. Refused on both instead.
        #
        # Matched case-insensitively and on the short form, because jq takes
        # all of nan, NAN, nAn, inf, Inf and INFINITY. The letters are checked
        # outside strings only, so a value that merely begins with them is
        # ordinary text.
        # (No apostrophes in this program: it is a single-quoted shell word.)
        if (c == "N" || c == "n" || c == "I" || c == "i") {
          rest = tolower(substr($0, i))
          if (rest ~ /^nan/ || rest ~ /^inf/) { bad = 1 }
        }
        # A magnitude no double can hold, which jq rewrites and the two
        # PowerShell versions disagree about. The exponent is compared rather
        # than counted: 1e308 is representable and 1e309 is not.
        if (c ~ /[0-9]/ && (i == 1 || substr($0, i - 1, 1) !~ /[0-9.eE+-]/)) {
          num = substr($0, i)
          sub(/[^0-9.eE+-].*$/, "", num)
          # Significant digits and a decimal exponent, from which the magnitude
          # follows without arithmetic — awk would saturate rather than compare.
          # The boundary decade needs the leading digits too, because the range
          # ends at 1.797…e308 rather than at a power of ten.
          expn = 0
          mant = num
          if (mant ~ /[eE]/) {
            expn = mant
            sub(/^[^eE]*[eE][+]?/, "", expn)
            expn = expn + 0
            sub(/[eE].*$/, "", mant)
          }
          digits = mant
          gsub(/[.]/, "", digits)
          sub(/^0+/, "", digits)
          sub(/[.].*$/, "", mant)
          sub(/^0+/, "", mant)
          magnitude = length(mant) + expn
          if (magnitude > 309) { bad = 1 }
          else if (magnitude == 309 && substr(digits "000", 1, 4) + 0 > 1797) { bad = 1 }
        }
        if (c == ",") { comma = 1; continue }
        if (c == " " || c == "\t" || c == "\r") { continue }
        if (comma && (c == "}" || c == "]")) { found = 1; exit }
        comma = 0
        if (c == "\"") { in_string = 1 }
      }
      escaped = 0
    }
    # `exit` runs END, so the verdict travels in a flag rather than in the exit
    # status of the rule body, which END would otherwise overwrite.
    END { exit (found ? 0 : (bad ? 2 : 1)) }
  ' "$1" 2>/dev/null
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
