# Floway

A self-hosted LLM API gateway with a web dashboard. Connect GitHub Copilot,
ChatGPT, Claude.ai, Azure AI, custom HTTP providers, and Ollama through OpenAI,
Anthropic, and Gemini-compatible APIs.

## Deployment

| Platform | Setup |
| --- | --- |
| Cloudflare Workers | Ask your coding agent to deploy with the [$deploy-to-cloudflare](.agents/skills/deploy-to-cloudflare/SKILL.md) skill. |
| Docker | Run the commands below. |
| Podman/systemd | Follow the [deployment guide](docker/systemd/README.md). |

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:8788> with a blank username and `ADMIN_KEY` as the password.
Add an upstream under **Providers → Upstreams** and a key under **Services → API Keys**.
Use the key as a bearer token or `x-api-key`, or use **Agent Setup** for Claude Code
or Codex. Docker stores persistent data in the `floway-data` volume.

**Development:** `pnpm install`, `pnpm run dev:node`; validate with `pnpm run verify`.

**License:** MIT
