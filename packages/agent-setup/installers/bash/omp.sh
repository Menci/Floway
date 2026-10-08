# Use the maintained upstream installer so release discovery follows upstream.
# https://omp.sh/install

omp_ensure_installed() {
  _discover_cli omp \
    "$HOME/.local/bin/omp" \
    "$HOME/.bun/bin/omp" \
    "/opt/homebrew/bin/omp" \
    "/usr/local/bin/omp"
  OMP_BIN=$DISCOVERED_BIN
  if [ "$DISCOVERED_COUNT" -gt 1 ]; then
    out_warn "multiple oh-my-pi installations detected; using $OMP_BIN"
  fi
  if [ "$DISCOVERED_COUNT" -ge 1 ]; then
    out_info 'oh-my-pi is already installed.'
    return 0
  fi

  if [ -n "${AGENT_SETUP_TEST_INSTALL_OMP_SCRIPT:-}" ]; then
    out_info 'oh-my-pi CLI not found; running the test installer'
    _iomp_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_iomp_timeout" env -u SETUP_API_KEY bash "$AGENT_SETUP_TEST_INSTALL_OMP_SCRIPT" </dev/null || return 1
  elif [ -n "${AGENT_SETUP_TEST_OMP_URL:-}" ]; then
    out_info 'oh-my-pi CLI not found; running the test installer download'
    _download_and_run_installer "$AGENT_SETUP_TEST_OMP_URL" || return 1
  else
    case "$(uname -s)" in
      Darwin | Linux) ;;
      *)
        out_error 'automatic oh-my-pi installation supports macOS and Linux only in the Bash installer.'
        return 1
        ;;
    esac
    if command -v npm >/dev/null 2>&1; then
      out_info 'oh-my-pi CLI not found; installing with npm'
      _install_npm_package '@oh-my-pi/pi-coding-agent' || return 1
    else
      out_info 'oh-my-pi CLI not found; installing from omp.sh'
      _download_and_run_installer 'https://omp.sh/install' || return 1
    fi
  fi
  hash -r
  _discover_cli omp \
    "$HOME/.local/bin/omp" \
    "$HOME/.bun/bin/omp" \
    "/opt/homebrew/bin/omp" \
    "/usr/local/bin/omp"
  OMP_BIN=$DISCOVERED_BIN
  [ "$DISCOVERED_COUNT" -ge 1 ]
}

omp_probe_version() {
  _ov_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-30}
  _ov_version_file="$SETUP_TMPDIR/omp-version.out"
  if _run_with_timeout "$_ov_timeout" "$OMP_BIN" --version > "$_ov_version_file" 2>&1; then
    :
  else
    _ov_status=$?
    if [ "$_ov_status" -eq 124 ]; then
      out_error '`omp --version` timed out.'
    else
      out_error '`omp --version` failed.'
    fi
    return 1
  fi
  out_info "oh-my-pi version: $(cat "$_ov_version_file")"
  if ! awk '
    { sub(/^omp\//, ""); if (NR != 1 || $0 !~ /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/) invalid=1; }
    END { exit NR == 1 && !invalid ? 0 : 1 }
  ' "$_ov_version_file"; then
    out_error 'oh-my-pi returned an invalid version.'
    return 1
  fi
}

omp_version_is_supported() {
  awk '
    { sub(/^omp\//, ""); prerelease = $0 ~ /^[0-9]+\.[0-9]+\.[0-9]+-/; split($0, version, "."); }
    END {
      major = version[1] + 0; minor = version[2] + 0; patch = version[3] + 0;
      exit major > 18 || (major == 18 && (minor > 8 || (minor == 8 && (patch > 4 || (patch == 4 && !prerelease))))) ? 0 : 1
    }
  ' "$SETUP_TMPDIR/omp-version.out"
}

omp_write_version() {
  omp_probe_version || return 1
  if omp_version_is_supported; then return 0; fi
  out_info 'Updating oh-my-pi to the latest stable version.'
  # The official updater resolves the active installation and update method.
  # https://github.com/can1357/oh-my-pi/blob/1a96f360262a7c26274646ea1e6c304d6a4ab7c8/packages/coding-agent/src/cli/update-cli.ts#L2272-L2331
  _ov_update_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
  if ! _run_with_timeout "$_ov_update_timeout" env -u SETUP_API_KEY "$OMP_BIN" update --stable </dev/null; then
    out_error 'could not update oh-my-pi to a supported version.'
    return 1
  fi
  hash -r
  _discover_cli omp "$HOME/.local/bin/omp" "$HOME/.bun/bin/omp" "/opt/homebrew/bin/omp" "/usr/local/bin/omp"
  OMP_BIN=$DISCOVERED_BIN
  if [ "$DISCOVERED_COUNT" -lt 1 ]; then
    out_error 'oh-my-pi CLI is unavailable after updating.'
    return 1
  fi
  omp_probe_version || return 1
  if ! omp_version_is_supported; then
    out_error 'Floway Agent Setup requires oh-my-pi 18.8.4 or newer; the selected CLI remains older after updating. Check for a shadowing installation.'
    return 1
  fi
}

omp_resolve_agent_dir() {
  OMP_AGENT_DIR=$("$OMP_BIN" config path) || return $?
  OMP_AGENT_DIR="${OMP_AGENT_DIR%$'\r'}"
  if [ -z "$OMP_AGENT_DIR" ]; then
    out_error '`omp config path` returned an empty path.'
    return 1
  fi
}

omp_backup_files() {
  OMP_EXTENSION_EXISTED=0
  OMP_CONFIG_EXISTED=0
  OMP_EXTENSION_BACKUP=""
  OMP_CONFIG_BACKUP=""
  _obf_stamp=$(date +%Y%m%d%H%M%S).$$
  if [ -e "$OMP_EXTENSION_PATH" ]; then
    OMP_EXTENSION_EXISTED=1
    OMP_EXTENSION_BACKUP="$OMP_EXTENSION_PATH.floway-backup.$_obf_stamp"
    if ! cp "$OMP_EXTENSION_PATH" "$OMP_EXTENSION_BACKUP"; then
      out_error "could not back up $OMP_EXTENSION_PATH"
      return 1
    fi
    if ! chmod 600 "$OMP_EXTENSION_BACKUP"; then
      rm -f "$OMP_EXTENSION_BACKUP"
      OMP_EXTENSION_BACKUP=""
      out_error "could not protect the backup of $OMP_EXTENSION_PATH"
      return 1
    fi
  fi
  if [ -e "$OMP_CONFIG_PATH" ]; then
    OMP_CONFIG_EXISTED=1
    OMP_CONFIG_BACKUP="$OMP_CONFIG_PATH.floway-backup.$_obf_stamp"
    if ! cp "$OMP_CONFIG_PATH" "$OMP_CONFIG_BACKUP"; then
      out_error "could not back up $OMP_CONFIG_PATH"
      return 1
    fi
  fi
}

omp_rollback() {
  if [ -n "${OMP_EXTENSION_STAGE:-}" ] && [ -e "$OMP_EXTENSION_STAGE" ]; then
    rm -f "$OMP_EXTENSION_STAGE"
  fi
  if [ -n "${OMP_CONFIG_STAGE:-}" ] && [ -e "$OMP_CONFIG_STAGE" ]; then
    rm -f "$OMP_CONFIG_STAGE"
  fi
  _obr_rc=0
  _restore_managed_file \
    "$OMP_EXTENSION_EXISTED" "$OMP_EXTENSION_BACKUP" "$OMP_EXTENSION_PATH" \
    "extension file" "oh-my-pi extension file" || _obr_rc=1
  _restore_managed_file \
    "$OMP_CONFIG_EXISTED" "$OMP_CONFIG_BACKUP" "$OMP_CONFIG_PATH" \
    "config file" "oh-my-pi config file" || _obr_rc=1
  return "$_obr_rc"
}

omp_cleanup_backups() {
  if [ -n "$OMP_EXTENSION_BACKUP" ]; then
    _prune_managed_backups "$OMP_EXTENSION_PATH" "$OMP_EXTENSION_BACKUP" || return 1
    if ! rm -f "$OMP_EXTENSION_BACKUP"; then
      out_error "could not remove extension backup $OMP_EXTENSION_BACKUP"
      return 1
    fi
    OMP_EXTENSION_BACKUP=""
  else
    _prune_managed_backups "$OMP_EXTENSION_PATH" "" || return 1
  fi

  if [ -n "$OMP_CONFIG_BACKUP" ]; then
    _prune_managed_backups "$OMP_CONFIG_PATH" "$OMP_CONFIG_BACKUP" || return 1
    if ! rm -f "$OMP_CONFIG_BACKUP"; then
      out_error "could not remove config backup $OMP_CONFIG_BACKUP"
      return 1
    fi
    OMP_CONFIG_BACKUP=""
  else
    _prune_managed_backups "$OMP_CONFIG_PATH" "" || return 1
  fi
}

omp_stage_extension() {
  OMP_EXTENSION_STAGE="$OMP_EXTENSION_PATH.floway-stage.$$"
  if [ -f "$OMP_EXTENSION_PATH" ] && { [ ! -s "$OMP_EXTENSION_PATH" ] || ! awk 'NR == 1 { exit $0 == "// Managed by Floway Agent Setup." ? 0 : 1 }' "$OMP_EXTENSION_PATH"; }; then
    out_error 'existing unmanaged Floway extension found; rename it before running Agent Setup.'
    return 1
  fi
  if ! (umask 077 && : > "$OMP_EXTENSION_STAGE") || ! chmod 600 "$OMP_EXTENSION_STAGE"; then
    out_error 'could not protect the oh-my-pi extension stage file.'
    return 1
  fi
  if ! curl -fsSL --connect-timeout 10 --max-time 30 --get --data-urlencode "endpoint=$SETUP_ENDPOINT" --data-urlencode "provider=$SETUP_OMP_PROVIDER" \
    -o "$OMP_EXTENSION_STAGE" "${SETUP_ENDPOINT%/}${SETUP_EXTENSION_PATH}"; then
    out_error 'could not download the oh-my-pi extension.'
    return 1
  fi
  if [ ! -s "$OMP_EXTENSION_STAGE" ] || ! awk 'NR == 1 { exit $0 == "// Managed by Floway Agent Setup." ? 0 : 1 }' "$OMP_EXTENSION_STAGE"; then
    out_error 'the gateway did not return a Floway extension.'
    return 1
  fi
  _merge_provider_extension "$OMP_EXTENSION_PATH" "$OMP_EXTENSION_STAGE" || return 1
}

omp_set_retry_scalar() {
  local key=$1 value=$2 header=-1 end indent="" field=-1 i line suffix
  local quoted_key_pattern="^[ ]+['\"]$key['\"]:"
  local header_pattern='^retry:[ ]*(#.*)?$' ignored_pattern='^[ ]*(#.*)?$' field_pattern
  field_pattern="^([ ]+)$key:[ ]*[A-Za-z0-9_.+-]*([ ]+(#.*)?)?$"
  for i in "${!_osc_new_lines[@]}"; do
    line=${_osc_new_lines[$i]}
    case "$line" in
      '"retry":'* | "'retry':"*)
        out_error 'quoted retry mapping keys cannot be edited safely.'
        return 1
        ;;
      retry:*)
        if [ "$header" -ne -1 ] || [[ ! $line =~ $header_pattern ]]; then
          out_error 'retry must be a single block-style YAML mapping without aliases.'
          return 1
        fi
        header=$i
        ;;
    esac
  done
  if [ "$header" -eq -1 ]; then
    _osc_new_lines+=("retry:" "  $key: $value")
    return 0
  fi
  end=${#_osc_new_lines[@]}
  for ((i = header + 1; i < ${#_osc_new_lines[@]}; i++)); do
    line=${_osc_new_lines[$i]}
    if [[ $line =~ $ignored_pattern ]]; then continue; fi
    case "$line" in
      ' '*) ;;
      *) end=$i; break ;;
    esac
    if [ -z "$indent" ] && [[ $line =~ ^([ ]+)[^[:space:]] ]]; then indent=${BASH_REMATCH[1]}; fi
    if [[ $line =~ $quoted_key_pattern ]]; then
      out_error "quoted retry.$key keys cannot be edited safely."
      return 1
    fi
    if [[ $line =~ ^([ ]+)$key: ]]; then
      if [ "${BASH_REMATCH[1]}" != "$indent" ] || [ "$field" -ne -1 ] || [[ ! $line =~ $field_pattern ]]; then
        out_error "retry.$key must be a single scalar with a valid value."
        return 1
      fi
      field=$i
    fi
  done
  if [ "$field" -ne -1 ]; then
    suffix=""
    line=${_osc_new_lines[$field]}
    if [[ $line =~ ([ ]+(#.*)?)$ ]]; then suffix=${BASH_REMATCH[1]}; fi
    _osc_new_lines[$field]="$indent$key: $value$suffix"
  else
    if [ -z "$indent" ]; then indent="  "; fi
    _osc_new_lines=("${_osc_new_lines[@]:0:$end}" "$indent$key: $value" "${_osc_new_lines[@]:$end}")
  fi
}

omp_set_default_role() {
  local header=-1 field=-1 end indent="" i line value scalar suffix prefix kind target other
  local header_pattern='^modelRoles:[ ]*(#.*)?$' field_pattern='^([ ]+)default:[ ]*(.*)$' quoted_key_pattern="^[ ]+['\"]default['\"]:"
  local single_pattern="^('([^']|'')*')([ ]*(#.*)?)$" double_pattern='^("([^"\\]|\\.)*")([ ]*(#.*)?)$'
  for i in "${!_osc_new_lines[@]}"; do
    line=${_osc_new_lines[$i]}
    case "$line" in
      '"modelRoles":'* | "'modelRoles':"*) out_error 'quoted modelRoles mapping keys cannot be edited safely.'; return 1 ;;
      modelRoles:*)
        if [ "$header" -ne -1 ] || [[ ! $line =~ $header_pattern ]]; then
          out_error 'modelRoles must be a single block-style YAML mapping without aliases.'
          return 1
        fi
        header=$i
        ;;
    esac
  done
  if [ "$header" -eq -1 ]; then
    if [ -n "$SETUP_OMP_MODEL" ]; then
      target=$("$JQ" -can --arg value "$SETUP_OMP_PROVIDER/$SETUP_OMP_MODEL" '$value') || return $?
      _osc_new_lines+=("modelRoles:" "  default: $target")
    fi
    return 0
  fi
  end=${#_osc_new_lines[@]}
  for ((i = header + 1; i < ${#_osc_new_lines[@]}; i++)); do
    line=${_osc_new_lines[$i]}
    if [[ $line =~ ^[\ ]*(#.*)?$ ]]; then continue; fi
    case "$line" in ' '*) ;; *) end=$i; break ;; esac
    if [ -z "$indent" ] && [[ $line =~ ^([\ ]+)[^[:space:]] ]]; then indent=${BASH_REMATCH[1]}; fi
    if [[ $line =~ $quoted_key_pattern ]]; then out_error 'quoted modelRoles.default keys cannot be edited safely.'; return 1; fi
    if [[ $line =~ $field_pattern ]]; then
      if [ "$field" -ne -1 ] || [ "${BASH_REMATCH[1]}" != "$indent" ]; then
        out_error 'modelRoles.default must be a single direct scalar.'
        return 1
      fi
      field=$i
      prefix=${BASH_REMATCH[1]}
      value=${BASH_REMATCH[2]}
      suffix=""
      case "$value" in
        '#'*) scalar=""; suffix=" $value"; kind=plain ;;
        "'"*)
          if [[ ! $value =~ $single_pattern ]]; then out_error 'modelRoles.default cannot be edited safely.'; return 1; fi
          scalar=${BASH_REMATCH[1]}; suffix=${BASH_REMATCH[3]}; kind=single
          ;;
        '"'*)
          if [[ ! $value =~ $double_pattern ]]; then out_error 'modelRoles.default cannot be edited safely.'; return 1; fi
          scalar=${BASH_REMATCH[1]}; suffix=${BASH_REMATCH[3]}; kind=double
          ;;
        *)
          case "$value" in '['* | '{'* | '&'* | '*'* | '!'* | '|'* | '>'*) out_error 'modelRoles.default cannot be edited safely.'; return 1 ;; esac
          scalar=${value%%' #'*}; suffix=${value#"$scalar"}
          target=${scalar%"${scalar##*[! ]}"}; suffix=${scalar#"$target"}$suffix; scalar=$target; kind=plain
          ;;
      esac
    else
      if [[ $line =~ ^[\ ]+\<\<: ]] || [[ ${line#*:} =~ ^[\ ]*[\&\*] ]]; then
        out_error 'YAML anchors, aliases, or merge keys touching modelRoles cannot be edited safely.'
        return 1
      fi
    fi
  done
  if [ -n "$SETUP_OMP_MODEL" ]; then
    target=$("$JQ" -can --arg value "$SETUP_OMP_PROVIDER/$SETUP_OMP_MODEL" '$value') || return $?
    if [ "$field" -ne -1 ]; then _osc_new_lines[$field]="$prefix""default: $target$suffix"
    else
      if [ -z "$indent" ]; then indent="  "; fi
      _osc_new_lines=("${_osc_new_lines[@]:0:$end}" "$indent""default: $target" "${_osc_new_lines[@]:$end}")
    fi
  elif [ "$field" -ne -1 ]; then
    case "$kind" in
      single | double) value=${scalar:1} ;;
      plain) value=$scalar ;;
    esac
    case "$value" in "$SETUP_OMP_PROVIDER/"*) ;; *) return 0 ;; esac
    if [[ $suffix =~ \# ]]; then _osc_new_lines[$field]="$prefix$suffix"
    else _osc_new_lines=("${_osc_new_lines[@]:0:$field}" "${_osc_new_lines[@]:$((field + 1))}"); end=$((end - 1)); fi
    other=0
    for ((i = header + 1; i < end; i++)); do
      if [[ ! ${_osc_new_lines[$i]} =~ ^[\ ]*(#.*)?$ ]]; then other=1; break; fi
    done
    if [ "$other" -eq 0 ]; then
      line=${_osc_new_lines[$header]}
      if [[ $line =~ \# ]]; then _osc_new_lines[$header]=${line#modelRoles:}
      else _osc_new_lines=("${_osc_new_lines[@]:0:$header}" "${_osc_new_lines[@]:$((header + 1))}"); fi
    fi
  fi
}

omp_stage_config() {
  OMP_CONFIG_STAGE=""
  if [ -z "$SETUP_OMP_MODEL$SETUP_OMP_RETRY_ENABLED$SETUP_OMP_MAX_RETRIES" ] && [ ! -f "$OMP_CONFIG_PATH" ]; then
    return 0
  fi

  OMP_CONFIG_STAGE="$OMP_CONFIG_PATH.floway-stage.$$"
  if ! (umask 077 && : > "$OMP_CONFIG_STAGE") || ! chmod 600 "$OMP_CONFIG_STAGE"; then
    out_error 'could not create or protect the oh-my-pi config stage file.'
    return 1
  fi

  _osc_new_lines=()
  _osc_eol=$'\n'
  _osc_bom=""
  _osc_has_nl=1

  if [ -f "$OMP_CONFIG_PATH" ]; then
    if awk '/\r$/ { found=1; exit } END { exit found ? 0 : 1 }' "$OMP_CONFIG_PATH"; then
      _osc_eol=$'\r\n'
    fi
    if [ -s "$OMP_CONFIG_PATH" ]; then
      _osc_last=""
      while IFS= read -r _osc_last; do :; done < "$OMP_CONFIG_PATH"
      if [ -n "$_osc_last" ]; then _osc_has_nl=0; fi
    fi
    while IFS= read -r _osc_line || [ -n "$_osc_line" ]; do
      _osc_new_lines+=("${_osc_line%$'\r'}")
    done < "$OMP_CONFIG_PATH"
  fi

  if [ "${#_osc_new_lines[@]}" -gt 0 ]; then
    case "${_osc_new_lines[0]}" in
      $'\357\273\277'*) _osc_bom=$'\357\273\277'; _osc_new_lines[0]=${_osc_new_lines[0]#"$_osc_bom"} ;;
    esac
  fi
  for ((_osc_i = 0; _osc_i < ${#_osc_new_lines[@]}; _osc_i++)); do
    _osc_l=${_osc_new_lines[$_osc_i]}
    if [[ $_osc_l =~ ^[\ ]*$'\t' ]]; then out_error "tabs found in $OMP_CONFIG_PATH; YAML disallows tab indentation."; return 1; fi
  done
  omp_set_default_role || return $?

  if [ -n "$SETUP_OMP_RETRY_ENABLED" ]; then
    omp_set_retry_scalar enabled "$SETUP_OMP_RETRY_ENABLED" || return 1
  fi
  if [ -n "$SETUP_OMP_MAX_RETRIES" ]; then
    omp_set_retry_scalar maxRetries "$SETUP_OMP_MAX_RETRIES" || return 1
  fi

  if [ -n "$_osc_bom" ]; then printf '%s' "$_osc_bom" >> "$OMP_CONFIG_STAGE" || return $?; fi
  for ((_osc_j = 0; _osc_j < ${#_osc_new_lines[@]}; _osc_j++)); do
    if [ "$_osc_j" -eq $((${#_osc_new_lines[@]} - 1)) ] && [ "$_osc_has_nl" -eq 0 ]; then
      printf '%s' "${_osc_new_lines[$_osc_j]}" >> "$OMP_CONFIG_STAGE" || return $?
    else
      printf '%s%s' "${_osc_new_lines[$_osc_j]}" "$_osc_eol" >> "$OMP_CONFIG_STAGE" || return $?
    fi
  done
  return 0
}

omp_apply_staged() {
  if ! mv "$OMP_EXTENSION_STAGE" "$OMP_EXTENSION_PATH"; then
    out_error "could not replace $OMP_EXTENSION_PATH"
    rm -f "$OMP_EXTENSION_STAGE"
    return 1
  fi
  OMP_EXTENSION_STAGE=""

  if [ -n "$OMP_CONFIG_STAGE" ]; then
    if [ -s "$OMP_CONFIG_STAGE" ]; then
      if ! mv "$OMP_CONFIG_STAGE" "$OMP_CONFIG_PATH"; then
        out_error "could not replace $OMP_CONFIG_PATH"
        rm -f "$OMP_CONFIG_STAGE"
        return 1
      fi
    else
      rm -f "$OMP_CONFIG_STAGE" "$OMP_CONFIG_PATH" || return $?
    fi
    OMP_CONFIG_STAGE=""
  fi
  return 0
}

configure_agent() {
  out_agent_notice 'Installing' 'oh-my-pi'
  if ! omp_ensure_installed; then
    out_error 'oh-my-pi CLI is unavailable and could not be installed.'
    return 1
  fi
  if ! omp_write_version; then
    return 1
  fi

  out_agent_notice 'Configuring' 'oh-my-pi'
  if ! omp_resolve_agent_dir; then
    return 1
  fi
  if ! mkdir -p "$OMP_AGENT_DIR"; then
    out_error "could not create $OMP_AGENT_DIR"
    return 1
  fi

  if ! mkdir -p "$OMP_AGENT_DIR/extensions"; then
    out_error 'could not create the oh-my-pi extensions directory.'
    return 1
  fi
  OMP_EXTENSION_PATH="$OMP_AGENT_DIR/extensions/floway.js"

  if [ -f "$OMP_AGENT_DIR/config.yml" ]; then
    OMP_CONFIG_PATH="$OMP_AGENT_DIR/config.yml"
  elif [ -f "$OMP_AGENT_DIR/config.yaml" ]; then
    OMP_CONFIG_PATH="$OMP_AGENT_DIR/config.yaml"
  else
    OMP_CONFIG_PATH="$OMP_AGENT_DIR/config.yml"
  fi

  if ! omp_backup_files; then
    return 1
  fi

  if ! omp_stage_extension; then
    out_warn 'oh-my-pi extension staging failed; rolling back configuration.'
    omp_rollback
    return 1
  fi

  if [ -n "${AGENT_SETUP_TEST_FAIL_CONFIG:-}" ]; then
    out_warn 'oh-my-pi simulated failure; rolling back configuration.'
    omp_rollback
    return 1
  fi

  if ! omp_stage_config; then
    out_warn 'oh-my-pi config staging failed; rolling back configuration.'
    omp_rollback
    return 1
  fi

  if ! omp_apply_staged; then
    out_warn 'oh-my-pi applying changes failed; rolling back configuration.'
    omp_rollback
    return 1
  fi

  omp_cleanup_backups || return 1

  out_info "Written to \`$OMP_EXTENSION_PATH\`."
  if [ -e "$OMP_CONFIG_PATH" ]; then
    out_info "Written to \`$OMP_CONFIG_PATH\`."
  fi
  out_agent_notice 'Completed Agent Setup' 'oh-my-pi'
}

main 'oh-my-pi' "$@"
