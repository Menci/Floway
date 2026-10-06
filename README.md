# Floway

Floway is a self-hosted LLM API gateway for coding agents and API clients, with
a web dashboard. It connects GitHub Copilot, ChatGPT, Claude.ai, Azure AI,
custom HTTP providers, and Ollama through OpenAI, Anthropic, and
Gemini-compatible APIs.

## Deployment

### Cloudflare Workers

Ask your agent or follow the
[$deploy-to-cloudflare](.agents/skills/deploy-to-cloudflare/SKILL.md) skill yourself
to configure and deploy Floway to your Cloudflare account.

### Docker

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:8788>, leave the username blank, and log in with
`ADMIN_KEY`. Data persists in the `floway-data` volume.

### Podman/systemd

Ask your agent or follow the [deployment guide](docker/systemd/README.md) yourself
to run Floway as a systemd service with Podman.

## Usage

Add an upstream under **Providers → Upstreams**, then create a key under
**Services → API Keys**. Use it as a bearer token or `x-api-key`, or configure
Claude Code and Codex through **Agent Setup**.

## Development

Install dependencies with `pnpm install`, start locally with `pnpm run dev:node`,
and run all checks with `pnpm run verify`.

## License

MIT
