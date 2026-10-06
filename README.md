# Floway

A self-hosted LLM API gateway with a dashboard. Connect GitHub Copilot,
ChatGPT, Claude.ai, Azure AI, custom providers, and Ollama through OpenAI,
Anthropic, and Gemini-compatible APIs.

## Deployment

### Cloudflare Workers

Use the
[$deploy-to-cloudflare](.agents/skills/deploy-to-cloudflare/SKILL.md) skill with your agent.

### Docker

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:8788> with a blank username and `ADMIN_KEY` as the password.
Add an upstream under **Providers → Upstreams**, then create a key under
**Services → API Keys**. Use it as a bearer token or `x-api-key`, or use
**Agent Setup** for Claude Code or Codex. Data persists in `floway-data`.

### Podman/systemd

Follow the [deployment guide](docker/systemd/README.md).

## Development

```bash
pnpm install
pnpm run dev:node
pnpm run verify
```

MIT licensed.
