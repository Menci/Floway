# Floway

A self-hosted LLM API gateway for coding agents and API clients, with a web
dashboard. Connect GitHub Copilot, ChatGPT, Claude.ai, Azure AI, custom HTTP
providers, and Ollama through OpenAI, Anthropic, and Gemini-compatible APIs.
Run on Docker, Node.js, or Cloudflare Workers.

## Quick Start

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:8788>, leave the username blank, and use `ADMIN_KEY` as
the password. Add an upstream under **Providers → Upstreams**, then create a
key under **Services → API Keys**. Use it as a bearer token or `x-api-key`, or
configure Claude Code and Codex through **Agent Setup**. Data persists in the
`floway-data` volume.

## Development

```bash
pnpm install
pnpm run dev:node
pnpm run verify
```

[Podman/systemd guide](docker/systemd/README.md) ·
[Agent guide](AGENTS.md)

MIT licensed.
