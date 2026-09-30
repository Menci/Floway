# Dev Container configuration for Floway

Tested frontends:
* DevPod
* VS Code
* Zed

Tested backends:
* Rootless Docker
* Rootless Podman

Software it provides:
* Debian Linux
* TypeScript development environment: `node` (version 22), `npm`, `pnpm`, `tsc`
* AI Coding Agents: `codex`, `pi`
* Basic Python environment: `python3`, `pip3`
* Text editing tools: `ed`, `ex`, `vi`, `vim`
* Text searching tools: `ripgrep`
* Project-specific npm packages are **not** installed since they update frequently and can be installed using `pnpm`.

This Dev Container configuration contains [a workaround](https://github.com/containers/bubblewrap/issues/505#issuecomment-5708882071) for VS Code terminal sandbox & Claude Code sandbox. Such configuration lowers a rootful container’s security barriers, so please only use with a rootless container engine (rootless Docker or rootless Podman).
