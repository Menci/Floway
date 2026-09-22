FROM mcr.microsoft.com/devcontainers/typescript-node:22

RUN <<EOF
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get dist-upgrade -y
    apt-get install -y command-not-found ed python-is-python3 python3-pip ripgrep vim-nox
    apt-get purge -y vim-tiny
    apt-file update
    apt-get autoremove -y --purge
    apt-get clean -y
    rm -rf /var/lib/apt/lists/*
    su "${_REMOTE_USER:-node}" -c 'unset HOME && export HOME=~ && umask 0002 && . "${NVM_DIR:-/usr/local/share/nvm}/nvm.sh" && npm install -g @openai/codex @earendil-works/pi-coding-agent'
    # Otherwise, VS Code will complain “vscode agent host failed to start” at a later step
    rm -rf /tmp/node-compile-cache
EOF
