# oh-my-pi (omp) Agent Setup fragment.

# Track upstream's maintained installer so release-metadata fixes arrive without
# waiting for a Floway update. Reviewed sources:
# https://github.com/can1357/oh-my-pi
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
  hash -r 2>/dev/null || true
  _discover_cli omp \
    "$HOME/.local/bin/omp" \
    "$HOME/.bun/bin/omp" \
    "/opt/homebrew/bin/omp" \
    "/usr/local/bin/omp"
  OMP_BIN=$DISCOVERED_BIN
  [ "$DISCOVERED_COUNT" -ge 1 ]
}

omp_write_version() {
  _ov_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-30}
  _ov_version_file="$SETUP_TMPDIR/omp-version.out"
  if _run_with_timeout "$_ov_timeout" "$OMP_BIN" --version > "$_ov_version_file" 2>&1; then
    out_info "oh-my-pi version: $(cat "$_ov_version_file")"
  else
    _ov_version_status=$?
    if [ "$_ov_version_status" -eq 124 ]; then
      out_error '`omp --version` timed out.'
    else
      out_error '`omp --version` failed.'
    fi
    return 1
  fi
}

omp_resolve_agent_dir() {
  _or_dir=""
  if command -v omp >/dev/null 2>&1; then
    _or_dir=$(omp config path 2>/dev/null || true)
    _or_dir="${_or_dir%%$'\n'*}"
    _or_dir="${_or_dir%$'\r'}"
  fi
  if [ -n "$_or_dir" ]; then
    OMP_AGENT_DIR="$_or_dir"
    return 0
  fi

  _or_root="${PI_CONFIG_DIR:-.omp}"
  if [ -n "${OMP_PROFILE:-}" ]; then
    OMP_AGENT_DIR="$HOME/$_or_root/profiles/$OMP_PROFILE/agent"
  elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    OMP_AGENT_DIR="$PI_CODING_AGENT_DIR"
  else
    OMP_AGENT_DIR="$HOME/$_or_root/agent"
  fi
  return 0
}

omp_backup_files() {
  OMP_MODELS_EXISTED=0
  OMP_CONFIG_EXISTED=0
  OMP_MODELS_BACKUP=""
  OMP_CONFIG_BACKUP=""
  _obf_stamp=$(date +%Y%m%d%H%M%S).$$
  if [ -e "$OMP_MODELS_PATH" ]; then
    OMP_MODELS_EXISTED=1
    OMP_MODELS_BACKUP="$OMP_MODELS_PATH.floway-backup.$_obf_stamp"
    if ! cp "$OMP_MODELS_PATH" "$OMP_MODELS_BACKUP"; then
      out_error "could not back up $OMP_MODELS_PATH"
      return 1
    fi
    if ! chmod 600 "$OMP_MODELS_BACKUP"; then
      rm -f "$OMP_MODELS_BACKUP"
      OMP_MODELS_BACKUP=""
      out_error "could not protect the backup of $OMP_MODELS_PATH"
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
  if [ -n "${OMP_MODELS_STAGE:-}" ] && [ -e "$OMP_MODELS_STAGE" ]; then
    rm -f "$OMP_MODELS_STAGE"
  fi
  if [ -n "${OMP_CONFIG_STAGE:-}" ] && [ -e "$OMP_CONFIG_STAGE" ]; then
    rm -f "$OMP_CONFIG_STAGE"
  fi
  _obr_rc=0
  _restore_managed_file \
    "${OMP_MODELS_EXISTED:-0}" "${OMP_MODELS_BACKUP:-}" "$OMP_MODELS_PATH" \
    "models file" "oh-my-pi models file" || _obr_rc=1
  _restore_managed_file \
    "${OMP_CONFIG_EXISTED:-0}" "${OMP_CONFIG_BACKUP:-}" "$OMP_CONFIG_PATH" \
    "config file" "oh-my-pi config file" || _obr_rc=1
  return "$_obr_rc"
}

omp_commit_files() {
  if [ -n "$OMP_MODELS_BACKUP" ]; then
    _prune_managed_backups "$OMP_MODELS_PATH" "$OMP_MODELS_BACKUP" || return 1
    if ! rm -f "$OMP_MODELS_BACKUP"; then
      out_error "could not remove models backup $OMP_MODELS_BACKUP"
      return 1
    fi
    OMP_MODELS_BACKUP=""
  else
    _prune_managed_backups "$OMP_MODELS_PATH" "" || return 1
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

omp_stage_models() {
  OMP_MODELS_STAGE="$OMP_MODELS_PATH.floway-stage.$$"
  if ! (umask 077 && : > "$OMP_MODELS_STAGE"); then
    out_error 'could not create the oh-my-pi models stage file.'
    return 1
  fi
  if ! chmod 600 "$OMP_MODELS_STAGE"; then
    out_error 'could not protect the oh-my-pi models stage file.'
    rm -f "$OMP_MODELS_STAGE"
    return 1
  fi

  _osm_lines=()
  _osm_eol=$'\n'
  _osm_has_nl=1

  if [ -f "$OMP_MODELS_PATH" ]; then
    if awk '/\r$/ { found=1; exit } END { exit found ? 0 : 1 }' "$OMP_MODELS_PATH"; then
      _osm_eol=$'\r\n'
    fi
    if [ -s "$OMP_MODELS_PATH" ]; then
      _osm_last=""
      while IFS= read -r _osm_last; do :; done < "$OMP_MODELS_PATH"
      if [ -n "$_osm_last" ]; then _osm_has_nl=0; fi
    fi
    while IFS= read -r _osm_line || [ -n "$_osm_line" ]; do
      _osm_lines+=("${_osm_line%$'\r'}")
    done < "$OMP_MODELS_PATH"
  fi

  _osm_begin_idx=-1
  _osm_end_idx=-1
  _osm_prov_idx=-1

  for _osm_i in "${!_osm_lines[@]}"; do
    _osm_l="${_osm_lines[$_osm_i]}"
    case "$_osm_l" in
      *$'\t'*)
        out_error "tabs found in $OMP_MODELS_PATH; YAML disallows tab indentation. Convert tabs to spaces and re-run."
        rm -f "$OMP_MODELS_STAGE"
        return 1
        ;;
    esac
    case "$_osm_l" in
      providers:*{* | *" providers:"*{*)
        out_error "flow-style 'providers:' mapping found in $OMP_MODELS_PATH; Floway Agent Setup only manages block-style YAML mappings."
        rm -f "$OMP_MODELS_STAGE"
        return 1
        ;;
    esac
    case "$_osm_l" in
      *"# floway:begin"* | *"#floway:begin"*)
        if [ "$_osm_begin_idx" -ne -1 ]; then
          out_error "multiple '# floway:begin' markers found in $OMP_MODELS_PATH; repair or remove them and re-run."
          rm -f "$OMP_MODELS_STAGE"
          return 1
        fi
        _osm_begin_idx=$_osm_i
        ;;
      *"# floway:end"* | *"#floway:end"*)
        if [ "$_osm_end_idx" -ne -1 ]; then
          out_error "multiple '# floway:end' markers found in $OMP_MODELS_PATH; repair or remove them and re-run."
          rm -f "$OMP_MODELS_STAGE"
          return 1
        fi
        _osm_end_idx=$_osm_i
        ;;
    esac
    case "$_osm_l" in
      "providers:" | "providers:"[[:space:]]* | "providers:"#*)
        _osm_prov_idx=$_osm_i
        ;;
    esac
  done

  if { [ "$_osm_begin_idx" -ne -1 ] && [ "$_osm_end_idx" -eq -1 ]; } || \
     { [ "$_osm_begin_idx" -eq -1 ] && [ "$_osm_end_idx" -ne -1 ]; } || \
     [ "$_osm_begin_idx" -gt "$_osm_end_idx" ]; then
    out_error "mismatched or malformed Floway markers in $OMP_MODELS_PATH; repair or remove them and re-run."
    rm -f "$OMP_MODELS_STAGE"
    return 1
  fi

  if [ "$_osm_prov_idx" -ne -1 ]; then
    case "${_osm_lines[$_osm_prov_idx]}" in
      *'&'* | *'*'* | *'<<:'*)
        out_error "YAML anchors, aliases, or merge keys found touching managed keys in $OMP_MODELS_PATH; Floway Agent Setup cannot safely edit YAML aliases."
        rm -f "$OMP_MODELS_STAGE"
        return 1
        ;;
    esac
    for ((_osm_j = _osm_prov_idx + 1; _osm_j < ${#_osm_lines[@]}; _osm_j++)); do
      _osm_l="${_osm_lines[$_osm_j]}"
      case "$_osm_l" in
        " "* | "	"*)
          case "$_osm_l" in
            *'&'* | *'*'* | *'<<:'*)
              out_error "YAML anchors, aliases, or merge keys found touching managed keys in $OMP_MODELS_PATH; Floway Agent Setup cannot safely edit YAML aliases."
              rm -f "$OMP_MODELS_STAGE"
              return 1
              ;;
          esac
          ;;
        "#"*) ;;
        "") ;;
        *) break ;;
      esac
    done
  fi

  for _osm_i in "${!_osm_lines[@]}"; do
    _osm_l="${_osm_lines[$_osm_i]}"
    case "$_osm_l" in
      "  floway:"* | " floway:"*)
        if [ "$_osm_begin_idx" -eq -1 ] || [ "$_osm_i" -lt "$_osm_begin_idx" ] || [ "$_osm_i" -gt "$_osm_end_idx" ]; then
          out_error "existing unmanaged 'floway' provider found in $OMP_MODELS_PATH without Floway markers; remove or rename it and re-run."
          rm -f "$OMP_MODELS_STAGE"
          return 1
        fi
        ;;
    esac
  done

  _osm_managed=(
    "  # floway:begin"
    "  floway:"
    "    baseUrl: ${SETUP_ENDPOINT%/}/v1"
    "    api: openai-responses"
    "    auth: apiKey"
    "    apiKey: $SETUP_API_KEY"
    "    headers: { User-Agent: floway-omp/1 }"
    "    discovery:"
    "      type: openai-models-list"
    "  # floway:end"
  )

  _osm_new_lines=()
  if [ "$_osm_begin_idx" -ne -1 ]; then
    for ((_osm_j = 0; _osm_j < _osm_begin_idx; _osm_j++)); do _osm_new_lines+=("${_osm_lines[$_osm_j]}"); done
    for ((_osm_j = 0; _osm_j < ${#_osm_managed[@]}; _osm_j++)); do _osm_new_lines+=("${_osm_managed[$_osm_j]}"); done
    for ((_osm_j = _osm_end_idx + 1; _osm_j < ${#_osm_lines[@]}; _osm_j++)); do _osm_new_lines+=("${_osm_lines[$_osm_j]}"); done
  elif [ "$_osm_prov_idx" -ne -1 ]; then
    for ((_osm_j = 0; _osm_j <= _osm_prov_idx; _osm_j++)); do _osm_new_lines+=("${_osm_lines[$_osm_j]}"); done
    for ((_osm_j = 0; _osm_j < ${#_osm_managed[@]}; _osm_j++)); do _osm_new_lines+=("${_osm_managed[$_osm_j]}"); done
    for ((_osm_j = _osm_prov_idx + 1; _osm_j < ${#_osm_lines[@]}; _osm_j++)); do _osm_new_lines+=("${_osm_lines[$_osm_j]}"); done
  else
    if [ "${#_osm_lines[@]}" -gt 0 ]; then
      for ((_osm_j = 0; _osm_j < ${#_osm_lines[@]}; _osm_j++)); do _osm_new_lines+=("${_osm_lines[$_osm_j]}"); done
    fi
    _osm_new_lines+=("providers:")
    for ((_osm_j = 0; _osm_j < ${#_osm_managed[@]}; _osm_j++)); do _osm_new_lines+=("${_osm_managed[$_osm_j]}"); done
    _osm_has_nl=1
  fi

  for ((_osm_j = 0; _osm_j < ${#_osm_new_lines[@]}; _osm_j++)); do
    if [ "$_osm_j" -eq $((${#_osm_new_lines[@]} - 1)) ] && [ "$_osm_has_nl" -eq 0 ]; then
      printf '%s' "${_osm_new_lines[$_osm_j]}" >> "$OMP_MODELS_STAGE"
    else
      printf '%s%s' "${_osm_new_lines[$_osm_j]}" "$_osm_eol" >> "$OMP_MODELS_STAGE"
    fi
  done
  return 0
}

omp_stage_config() {
  OMP_CONFIG_STAGE=""
  if [ -z "${SETUP_OMP_MODEL:-}" ] && [ ! -f "$OMP_CONFIG_PATH" ]; then
    return 0
  fi

  OMP_CONFIG_STAGE="$OMP_CONFIG_PATH.floway-stage.$$"
  if ! (umask 077 && : > "$OMP_CONFIG_STAGE"); then
    out_error 'could not create the oh-my-pi config stage file.'
    return 1
  fi

  _osc_lines=()
  _osc_eol=$'\n'
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
      _osc_lines+=("${_osc_line%$'\r'}")
    done < "$OMP_CONFIG_PATH"
  fi

  _osc_begin_idx=-1
  _osc_end_idx=-1
  _osc_roles_idx=-1

  for _osc_i in "${!_osc_lines[@]}"; do
    _osc_l="${_osc_lines[$_osc_i]}"
    case "$_osc_l" in
      *$'\t'*)
        out_error "tabs found in $OMP_CONFIG_PATH; YAML disallows tab indentation. Convert tabs to spaces and re-run."
        rm -f "$OMP_CONFIG_STAGE"
        return 1
        ;;
    esac
    case "$_osc_l" in
      modelRoles:*{* | *" modelRoles:"*{*)
        out_error "flow-style 'modelRoles:' mapping found in $OMP_CONFIG_PATH; Floway Agent Setup only manages block-style YAML mappings."
        rm -f "$OMP_CONFIG_STAGE"
        return 1
        ;;
    esac
    case "$_osc_l" in
      *"# floway:begin"* | *"#floway:begin"*)
        if [ "$_osc_begin_idx" -ne -1 ]; then
          out_error "multiple '# floway:begin' markers found in $OMP_CONFIG_PATH; repair or remove them and re-run."
          rm -f "$OMP_CONFIG_STAGE"
          return 1
        fi
        _osc_begin_idx=$_osc_i
        ;;
      *"# floway:end"* | *"#floway:end"*)
        if [ "$_osc_end_idx" -ne -1 ]; then
          out_error "multiple '# floway:end' markers found in $OMP_CONFIG_PATH; repair or remove them and re-run."
          rm -f "$OMP_CONFIG_STAGE"
          return 1
        fi
        _osc_end_idx=$_osc_i
        ;;
    esac
    case "$_osc_l" in
      "modelRoles:" | "modelRoles:"[[:space:]]* | "modelRoles:"#*)
        _osc_roles_idx=$_osc_i
        ;;
    esac
  done

  if { [ "$_osc_begin_idx" -ne -1 ] && [ "$_osc_end_idx" -eq -1 ]; } || \
     { [ "$_osc_begin_idx" -eq -1 ] && [ "$_osc_end_idx" -ne -1 ]; } || \
     [ "$_osc_begin_idx" -gt "$_osc_end_idx" ]; then
    out_error "mismatched or malformed Floway markers in $OMP_CONFIG_PATH; repair or remove them and re-run."
    rm -f "$OMP_CONFIG_STAGE"
    return 1
  fi

  if [ "$_osc_roles_idx" -ne -1 ]; then
    case "${_osc_lines[$_osc_roles_idx]}" in
      *'&'* | *'*'* | *'<<:'*)
        out_error "YAML anchors, aliases, or merge keys found touching managed keys in $OMP_CONFIG_PATH; Floway Agent Setup cannot safely edit YAML aliases."
        rm -f "$OMP_CONFIG_STAGE"
        return 1
        ;;
    esac
    for ((_osc_j = _osc_roles_idx + 1; _osc_j < ${#_osc_lines[@]}; _osc_j++)); do
      _osc_l="${_osc_lines[$_osc_j]}"
      case "$_osc_l" in
        " "* | "	"*)
          case "$_osc_l" in
            *'&'* | *'*'* | *'<<:'*)
              out_error "YAML anchors, aliases, or merge keys found touching managed keys in $OMP_CONFIG_PATH; Floway Agent Setup cannot safely edit YAML aliases."
              rm -f "$OMP_CONFIG_STAGE"
              return 1
              ;;
          esac
          ;;
        "#"*) ;;
        "") ;;
        *) break ;;
      esac
    done
  fi

  if [ -n "${SETUP_OMP_MODEL:-}" ] && [ "$_osc_roles_idx" -ne -1 ]; then
    for ((_osc_j = _osc_roles_idx + 1; _osc_j < ${#_osc_lines[@]}; _osc_j++)); do
      _osc_l="${_osc_lines[$_osc_j]}"
      case "$_osc_l" in
        " "* | "	"*)
          case "$_osc_l" in
            "  default:"* | " default:"*)
              if [ "$_osc_begin_idx" -eq -1 ] || [ "$_osc_j" -lt "$_osc_begin_idx" ] || [ "$_osc_j" -gt "$_osc_end_idx" ]; then
                out_error "existing unmanaged 'modelRoles.default' found in $OMP_CONFIG_PATH without Floway markers; remove it and re-run."
                rm -f "$OMP_CONFIG_STAGE"
                return 1
              fi
              ;;
          esac
          ;;
        "#"*) ;;
        "") ;;
        *) break ;;
      esac
    done
  fi

  _osc_new_lines=()

  if [ -z "${SETUP_OMP_MODEL:-}" ]; then
    if [ "$_osc_begin_idx" -eq -1 ]; then
      if [ ! -f "$OMP_CONFIG_PATH" ]; then
        rm -f "$OMP_CONFIG_STAGE"
        OMP_CONFIG_STAGE=""
        return 0
      fi
      for ((_osc_j = 0; _osc_j < ${#_osc_lines[@]}; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
    else
      for ((_osc_j = 0; _osc_j < _osc_begin_idx; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
      for ((_osc_j = _osc_end_idx + 1; _osc_j < ${#_osc_lines[@]}; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
    fi
  else
    _osc_escaped="${SETUP_OMP_MODEL//\'/\'\'}"
    _osc_target="'floway/$_osc_escaped'"
    if [ "$_osc_begin_idx" -ne -1 ]; then
      _osc_wraps_roles=0
      if [ "$((_osc_begin_idx + 1))" -eq "$_osc_roles_idx" ]; then _osc_wraps_roles=1; fi
      for ((_osc_j = 0; _osc_j < _osc_begin_idx; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
      if [ "$_osc_wraps_roles" -eq 1 ]; then
        _osc_new_lines+=("# floway:begin")
        _osc_new_lines+=("modelRoles:")
        _osc_new_lines+=("  default: $_osc_target")
        _osc_new_lines+=("# floway:end")
      else
        _osc_new_lines+=("  # floway:begin")
        _osc_new_lines+=("  default: $_osc_target")
        _osc_new_lines+=("  # floway:end")
      fi
      for ((_osc_j = _osc_end_idx + 1; _osc_j < ${#_osc_lines[@]}; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
    elif [ "$_osc_roles_idx" -ne -1 ]; then
      for ((_osc_j = 0; _osc_j <= _osc_roles_idx; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
      _osc_new_lines+=("  # floway:begin")
      _osc_new_lines+=("  default: $_osc_target")
      _osc_new_lines+=("  # floway:end")
      for ((_osc_j = _osc_roles_idx + 1; _osc_j < ${#_osc_lines[@]}; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
    else
      if [ "${#_osc_lines[@]}" -gt 0 ]; then
        for ((_osc_j = 0; _osc_j < ${#_osc_lines[@]}; _osc_j++)); do _osc_new_lines+=("${_osc_lines[$_osc_j]}"); done
      fi
      _osc_new_lines+=("# floway:begin")
      _osc_new_lines+=("modelRoles:")
      _osc_new_lines+=("  default: $_osc_target")
      _osc_new_lines+=("# floway:end")
      _osc_has_nl=1
    fi
  fi

  for ((_osc_j = 0; _osc_j < ${#_osc_new_lines[@]}; _osc_j++)); do
    if [ "$_osc_j" -eq $((${#_osc_new_lines[@]} - 1)) ] && [ "$_osc_has_nl" -eq 0 ]; then
      printf '%s' "${_osc_new_lines[$_osc_j]}" >> "$OMP_CONFIG_STAGE"
    else
      printf '%s%s' "${_osc_new_lines[$_osc_j]}" "$_osc_eol" >> "$OMP_CONFIG_STAGE"
    fi
  done
  return 0
}

omp_apply_staged() {
  if ! mv "$OMP_MODELS_STAGE" "$OMP_MODELS_PATH"; then
    out_error "could not replace $OMP_MODELS_PATH"
    rm -f "$OMP_MODELS_STAGE"
    return 1
  fi
  chmod 600 "$OMP_MODELS_PATH" 2>/dev/null || true
  OMP_MODELS_STAGE=""

  if [ -n "$OMP_CONFIG_STAGE" ]; then
    if [ -s "$OMP_CONFIG_STAGE" ]; then
      if ! mv "$OMP_CONFIG_STAGE" "$OMP_CONFIG_PATH"; then
        out_error "could not replace $OMP_CONFIG_PATH"
        rm -f "$OMP_CONFIG_STAGE"
        return 1
      fi
      chmod 600 "$OMP_CONFIG_PATH" 2>/dev/null || true
    else
      rm -f "$OMP_CONFIG_STAGE"
      rm -f "$OMP_CONFIG_PATH"
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

  if [ -f "$OMP_AGENT_DIR/models.yml" ]; then
    OMP_MODELS_PATH="$OMP_AGENT_DIR/models.yml"
  elif [ -f "$OMP_AGENT_DIR/models.yaml" ]; then
    OMP_MODELS_PATH="$OMP_AGENT_DIR/models.yaml"
  elif [ -f "$OMP_AGENT_DIR/models.json" ]; then
    out_error 'found models.json without models.yml; start omp once to migrate models.json to models.yml, or migrate it by hand.'
    return 1
  else
    OMP_MODELS_PATH="$OMP_AGENT_DIR/models.yml"
  fi

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

  if ! omp_stage_models; then
    out_warn 'oh-my-pi models staging failed; rolling back configuration.'
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

  if ! omp_commit_files; then
    out_warn 'oh-my-pi backup cleanup failed; rolling back configuration.'
    omp_rollback
    return 1
  fi

  out_info "Written to \`$OMP_MODELS_PATH\`."
  if [ -e "$OMP_CONFIG_PATH" ]; then
    out_info "Written to \`$OMP_CONFIG_PATH\`."
  fi
  out_agent_notice 'Completed Agent Setup' 'oh-my-pi'
}

main 'oh-my-pi' "$@"
