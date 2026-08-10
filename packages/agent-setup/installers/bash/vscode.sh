# VS Code Agent Setup fragment.

# VS Code is configured, not installed: the editor ships outside any package
# manager this script drives, so an absent user directory is a hard stop.
#
# The managed document is `chatLanguageModels.json`, which the bundled Copilot
# extension's `customendpoint` vendor reads. It sits beside `settings.json` in
# the profile directory and holds a top-level array of provider groups; VS Code
# rewrites the whole file whenever the Manage Models UI changes anything, so
# comments in it are already volatile and a jq merge costs nothing. Nothing
# upstream keeps the list unique, so the merge is what collapses ours: it
# selects every group of our vendor and name and replaces them with one.
# Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/platform/userDataProfile/common/userDataProfile.ts#L204
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts#L390-L417
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts#L215-L238
# The group is rebuilt rather than patched, so anything the operator owns inside
# it has to be carried across by name. `settings` is theirs: VS Code writes the
# Thinking Effort chosen in the picker into our group, keyed by model id, and
# reads it back on every resolve — dropping it reverts every choice to the
# schema default with nothing on screen, on a re-run they did for an unrelated
# reason. Foreign groups keep theirs because they are copied whole.
# A file the operator merged by hand can hold two groups under our name. `last`,
# not `first`: VS Code applies each matching group's settings in array order
# into one map keyed by model, so the later group is the one whose Thinking
# Efforts were in effect, and keeping the first would preserve the settings it
# was ignoring while dropping the ones it was using.
# Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L1551-L1562
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L1211-L1214
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L1252-L1262
VSCODE_MERGE_PROGRAM='
  if type != "array" then error("root is not a JSON array") else . end
  | ([.[] | select(.vendor == "customendpoint" and .name == $providerName) | select(has("settings")) | {settings}] | last) as $kept
  | map(select((.vendor != "customendpoint") or (.name != $providerName)))
  + [({
      "vendor": "customendpoint",
      "name": $providerName,
      "apiType": $apiType,
      "models": [$models[0][] | . + {
        "url": $apiUrl,
        "requestHeaders": { "authorization": ("Bearer " + env.SETUP_API_KEY) },
      }],
    } + ($kept // {}))]
'

# `customendpoint` appends the API path itself, so the group takes the bare
# origin plus a version segment: a URL already ending in `/vN` gets the path
# appended to it, while a bare host would have `/v1` inserted. A URL already
# carrying `/responses`, `/chat/completions`, or `/messages` anywhere in it is
# treated as fully resolved, which is why nothing here appends one.
# Ref: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L22-L59
vscode_api_url() {
  printf '%s/v1' "$SETUP_ENDPOINT"
}

# The stable, Insiders, and VSCodium builds keep separate user directories, and
# an operator may run more than one. Every one that exists is configured, so a
# single run serves whichever build the operator actually opens. An override is
# held to the same existence check, so a wrong path reports rather than failing
# later against a directory nothing can be written to.
vscode_user_dirs() {
  # Newline-separated, because the real enumeration below yields several
  # directories and an override that could only name one could not stand in for
  # an operator running more than one build.
  if [ -n "${AGENT_SETUP_TEST_VSCODE_USER_DIR:-}" ]; then
    printf '%s\n' "$AGENT_SETUP_TEST_VSCODE_USER_DIR" | while IFS= read -r _vud_override; do
      [ -n "$_vud_override" ] && [ -d "$_vud_override" ] && printf '%s\n' "$_vud_override"
    done
    return 0
  fi
  case "$(uname -s)" in
    Darwin) _vud_base="$HOME/Library/Application Support" ;;
    *) _vud_base="${XDG_CONFIG_HOME:-$HOME/.config}" ;;
  esac
  for _vud_app in 'Code' 'Code - Insiders' 'VSCodium'; do
    [ -d "$_vud_base/$_vud_app/User" ] && printf '%s\n' "$_vud_base/$_vud_app/User"
  done
  return 0
}

# A named profile keeps its own copy of the file under an opaque directory, so
# every profile of every build is configured rather than only the default one.
# The id is a hash rather than the display name, so the directories are
# enumerated instead of derived.
vscode_profile_dirs() {
  _vpd_user=$1
  printf '%s\n' "$_vpd_user"
  [ -d "$_vpd_user/profiles" ] || return 0
  # A directory we cannot enter yields nothing from the glob, which would read
  # as "no named profiles" and report success. The PowerShell half warns; say
  # the same thing here rather than silently configuring only the default.
  if [ ! -r "$_vpd_user/profiles" ] || [ ! -x "$_vpd_user/profiles" ]; then
    out_warn "could not list profiles under $_vpd_user/profiles; configuring the default profile only."
    return 0
  fi
  for _vpd_profile in "$_vpd_user"/profiles/*/; do
    [ -d "$_vpd_profile" ] || continue
    # `builtin` is not a profile: it is the container the agents window's
    # profile sits under, at `profiles/builtin/agents`. That profile's language
    # models resolve to the default profile's file, so a document written at
    # `profiles/builtin` is one nothing reads — and it would carry the key.
    # Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/platform/userDataProfile/common/userDataProfile.ts#L402
    #       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/platform/userDataProfile/common/userDataProfile.ts#L204
    #       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/platform/userDataProfile/common/userDataProfile.ts#L300
    _vpd_name=${_vpd_profile%/}
    [ "${_vpd_name##*/}" = builtin ] && continue
    printf '%s\n' "${_vpd_profile%/}"
  done
  return 0
}

# `customendpoint` reads only `id` off a `/models` response and drops every
# model it cannot type — no known-models table, no capability resolver — and a
# group-level `url` short-circuits into that discovery branch while suppressing
# the explicit `models` list, leaving the provider empty. So the gateway
# projects the catalog and embeds it here instead.
# Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts#L145-L163
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L135-L149
#
# Written to a file rather than passed as a jq argument: a large catalog would
# exceed the per-argument size limit, and --slurpfile reads it back as
# $models[0]. Kept ahead of the settings write so the empty check cannot fail
# after a backup exists.
vscode_stage_models() {
  VSCODE_MODELS_PROJECTED="$SETUP_TMPDIR/vscode-models.json"
  printf '%s' "$SETUP_VSCODE_MODELS" > "$VSCODE_MODELS_PROJECTED"
  if ! VSCODE_MODEL_COUNT=$("$JQ" 'length' "$VSCODE_MODELS_PROJECTED"); then
    out_error 'the embedded VS Code model list is not readable.'
    return 1
  fi
  if [ "$VSCODE_MODEL_COUNT" -eq 0 ]; then
    out_error 'the gateway advertises no chat models; nothing to configure.'
    return 1
  fi
}

vscode_rollback_settings() {
  _restore_managed_file \
    "${VSCODE_SETTINGS_EXISTED:-0}" "${VSCODE_SETTINGS_BACKUP:-}" "$VSCODE_SETTINGS_PATH" \
    "file" "VS Code language models"
}

# The key rides in `requestHeaders` rather than the group's `apiKey`: that
# property is declared `secret`, so VS Code runs its `${input:...}` decoder over
# whatever it finds there and a literal decodes to a secret-storage miss,
# leaving an empty Authorization header. `requestHeaders` survives the header
# sanitizer — `customendpoint` un-reserves `authorization` for endpoints behind
# gateways, where the URL heuristic cannot infer the right header — and supplying
# it also suppresses the default inferred one. The trade is that the key sits in
# the file rather than the keychain.
# Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/package.json#L2010-L2016
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L2158-L2167
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L185-L212
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L257-L298
vscode_write_settings() {
  if ! VSCODE_SETTINGS_PATH=$(_resolve_managed_path "$1/chatLanguageModels.json"); then
    return 1
  fi
  VSCODE_SETTINGS_BACKUP=""
  VSCODE_SETTINGS_EXISTED=0

  if [ -e "$VSCODE_SETTINGS_PATH" ]; then
    VSCODE_SETTINGS_EXISTED=1
    # jq has no lenient mode and is about to refuse this file. Name that cause
    # rather than reporting a malformed provider list. Unlike Zed's document the
    # syntax is not the operator's to keep — VS Code rewrites this file whole on
    # its own next edit — so the refusal is about the two halves agreeing, not
    # about preserving anything.
    # The status is captured rather than branched on directly: the scanner
    # answers with three of them, and `$?` would be clobbered by the `case`
    # itself.
    # Readability is asked first: awk prints no verdict for a file it cannot
    # open, and that is indistinguishable from the scanner failing — the
    # operator would be sent after the scanner for a permission problem.
    if [ ! -r "$VSCODE_SETTINGS_PATH" ]; then
      out_error "$VSCODE_SETTINGS_PATH could not be read; leaving it untouched."
      return 1
    fi
    _vw_verdict=0
    _json_has_jsonc_syntax "$VSCODE_SETTINGS_PATH" || _vw_verdict=$?
    case $_vw_verdict in
      0)
        out_error "$VSCODE_SETTINGS_PATH carries JSONC syntax this installer cannot preserve; leaving it untouched."
        return 1
        ;;
      2)
        # jq would take NaN or Infinity and rewrite it, changing a value inside
        # a foreign group. The PowerShell half refuses such a document, and one
        # file has to get one answer.
        out_error "$VSCODE_SETTINGS_PATH is not a provider list; leaving it untouched."
        return 1
        ;;
      3)
        # No verdict came back at all: the scanner itself failed. Its own
        # vocabulary cannot describe that, and the document is readable and may
        # be perfectly valid, so blaming its content would send the operator
        # after the wrong file.
        out_error "${VSCODE_SETTINGS_PATH} could not be examined; leaving it untouched."
        return 1
        ;;
    esac
    # `-s -e` rather than a filter that raises: jq runs a filter zero times on
    # empty input and once per document on a stream, so an empty file and a
    # multi-document file would both pass an unslurped gate and fail later as a
    # staging error naming the wrong cause. Elements are checked too: the merge
    # indexes `.vendor` on each one, which aborts on a scalar, and the
    # PowerShell filter would instead keep it and rewrite the file — the same
    # document accepted on one platform, refused on the other.
    if ! "$JQ" -s -e 'length == 1 and (.[0] | type == "array") and (.[0] | all(.[]; type == "object"))' \
        "$VSCODE_SETTINGS_PATH" >/dev/null 2>&1; then
      out_error "$VSCODE_SETTINGS_PATH is not a provider list; leaving it untouched."
      return 1
    fi
    _vw_base=$(cat "$VSCODE_SETTINGS_PATH")
    VSCODE_SETTINGS_BACKUP="$VSCODE_SETTINGS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! _back_up_managed_file "$VSCODE_SETTINGS_PATH" "$VSCODE_SETTINGS_BACKUP" own-mode; then
      VSCODE_SETTINGS_BACKUP=""
      return 1
    fi
    # A re-run copies a document that already holds the key, so the backup is
    # restricted explicitly rather than left to the umask — the PowerShell half
    # states it the same way. `own-mode` is what puts the copy under the umask
    # in the first place; here that is wanted, since the mode being dropped is
    # the wide one an operator may have had before the first run.
    if ! chmod 600 "$VSCODE_SETTINGS_BACKUP"; then
      rm -f "$VSCODE_SETTINGS_BACKUP"
      VSCODE_SETTINGS_BACKUP=""
      out_error "could not protect the backup of $VSCODE_SETTINGS_PATH"
      return 1
    fi
  else
    _vw_base='[]'
  fi

  _vw_stage="$VSCODE_SETTINGS_PATH.floway-stage.$$"
  # The document carries the API key, so the stage is owner-only before any
  # secret JSON reaches it, matching the PowerShell half. The umask this script
  # sets would produce the same mode, but a file holding a key should not depend
  # on a setting made at a distance. The redirect below overwrites this file
  # rather than recreating it, so the mode carries through to the rename.
  if ! : > "$_vw_stage" || ! chmod 600 "$_vw_stage"; then
    out_error "could not create $_vw_stage"
    rm -f "$_vw_stage"
    vscode_rollback_settings
    return 1
  fi
  if ! printf '%s' "$_vw_base" | SETUP_API_KEY="$SETUP_API_KEY" "$JQ" \
      --arg providerName "$SETUP_VSCODE_PROVIDER_NAME" \
      --arg apiType "$SETUP_VSCODE_API_TYPE" \
      --arg apiUrl "$(vscode_api_url)" \
      --slurpfile models "$VSCODE_MODELS_PROJECTED" \
      "$VSCODE_MERGE_PROGRAM" > "$_vw_stage"; then
    out_error 'failed to construct the updated VS Code provider list.'
    rm -f "$_vw_stage"
    vscode_rollback_settings
    return 1
  fi

  # An assertion on the merge program, not a gate on operator input: an empty
  # catalog is refused long before this, and every malformed document the merge
  # could choke on is refused before the backup. Nothing reachable fails it,
  # which is the point — it is what keeps a silently wrong merge from being
  # renamed over the operator's file. The PowerShell half asserts the same two
  # properties.
  if ! "$JQ" -e --arg providerName "$SETUP_VSCODE_PROVIDER_NAME" '
      (type == "array")
      and ([.[] | select(.vendor == "customendpoint" and .name == $providerName)] | length == 1)
      and (any(.[]; .vendor == "customendpoint" and .name == $providerName and (.models | length) > 0))
    ' "$_vw_stage" >/dev/null 2>&1; then
    out_error 'the staged VS Code provider list failed validation.'
    rm -f "$_vw_stage"
    vscode_rollback_settings
    return 1
  fi

  if ! mv "$_vw_stage" "$VSCODE_SETTINGS_PATH"; then
    out_error "could not replace $VSCODE_SETTINGS_PATH"
    rm -f "$_vw_stage"
    vscode_rollback_settings
    return 1
  fi
  if ! _prune_managed_backups "$VSCODE_SETTINGS_PATH" "$VSCODE_SETTINGS_BACKUP"; then
    vscode_rollback_settings
    return 1
  fi
  out_info "Configured $VSCODE_MODEL_COUNT model(s) in $VSCODE_SETTINGS_PATH"
}

# Every installed build and every profile within it is configured in one pass,
# because the operator's active profile is not discoverable from outside the
# editor. Each profile is its own transaction — one that cannot be written is
# rolled back to its own previous contents — and a failure does not stop the
# others, so a single hand-edited file cannot leave every remaining profile
# unconfigured. The run still exits non-zero and names what failed.
configure_agent() {
  out_agent_notice 'Configuring' 'VS Code'
  _ca_dirs=$(vscode_user_dirs)
  if [ -z "$_ca_dirs" ]; then
    out_error 'no VS Code user directory found; install and launch VS Code once, then re-run this command.'
    return 1
  fi
  if ! ensure_jq; then
    out_error 'jq is required to update the VS Code provider list.'
    return 1
  fi
  if ! vscode_stage_models; then
    return 1
  fi

  # The directory list is walked from a file rather than a pipeline: a `while`
  # reading from a pipe runs in a subshell, where a failure could not stop the
  # loop or be seen by the caller.
  _ca_list="$SETUP_TMPDIR/vscode-profiles"
  : > "$_ca_list"
  printf '%s\n' "$_ca_dirs" | while IFS= read -r _ca_user; do
    [ -n "$_ca_user" ] || continue
    out_info "VS Code user directory: $_ca_user"
    vscode_profile_dirs "$_ca_user" >> "$_ca_list"
  done

  _ca_failed=0
  while IFS= read -r _ca_profile; do
    [ -n "$_ca_profile" ] || continue
    if ! vscode_write_settings "$_ca_profile"; then
      _ca_failed=$((_ca_failed + 1))
    fi
  done < "$_ca_list"
  if [ "$_ca_failed" -ne 0 ]; then
    out_error "$_ca_failed VS Code profile(s) could not be configured; see the errors above."
    return 1
  fi

  out_info 'Restart VS Code if it is running.'
  out_agent_notice 'Completed Agent Setup' 'VS Code'
}


main 'VS Code' "$@"


