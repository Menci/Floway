<h1 align="center">
  <img src="apps/web/src/assets/floway-blue.svg" alt="Floway logo" width="120" height="120"><br>
  Floway
</h1>

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
**Services → API Keys**. Use the API key in your client code or configure your
agents to use Floway as provider through **Agent Setup**.

Pi and OMP setup installs a private provider extension and automatically updates
older clients to the required version (Pi 1.1.0 or OMP 18.8.4). OMP uses its native
`omp update` command, preserving the configured release channel. Setup verifies
the selected executable's effective version before writing configuration.

Choose a provider ID such as `floway-home` or `floway-work` to connect multiple
Floway instances through one extension. Repeating setup updates that provider and preserves the
other connections and manual model configuration. Selecting a default model
sets the agent-wide startup default; leaving it unset clears that default only
when it belongs to the selected provider. Other OMP model roles are preserved.
Pi thinking level and both clients' retry settings are optional agent-wide
preferences; leaving them unset preserves the existing settings.

Pi keeps connection endpoints in the agent directory's `floway.json` and keys in
its native `auth.json`. OMP installs a local `@floway-dev/omp` plugin through
`omp plugin link`; its native `plugins/omp-plugins.lock.json` stores connections
under `settings["@floway-dev/omp"].connections`. Setup uses OMP's own directory
resolver for profiles and XDG layouts and preserves other plugins' settings.
For example, the OMP settings namespace can contain multiple instances:

```json
{
  "settings": {
    "@floway-dev/omp": {
      "connections": [
        { "provider": "floway-home", "endpoint": "https://home.example", "apiKey": "home-key" },
        { "provider": "floway-work", "endpoint": "https://work.example", "apiKey": "work-key" }
      ]
    }
  }
}
```

Models are discovered at startup, including reasoning controls, vision, token
limits, and pricing. Pi refreshes them when the model picker opens; OMP refreshes
them with `/floway-refresh`, rereading its native plugin settings. The server
selects native Responses or Messages according to each model's capabilities, so
catalog changes take effect without rerunning setup. Extensions forward complete
native model definitions without a Floway metadata field list. Adding metadata
accepted by the installed client's registration API only requires a server
update; startup or model refresh applies it to the existing extension. Native
client API changes or new client operations may require an extension update.

Pi setup requires Node.js >= 22.19. Its extension explicitly negotiates response
compression for discovery and inference, advertising Zstandard only when the
runtime provides the decoder. Early Node 23 releases therefore use gzip, deflate
or Brotli without triggering Undici's missing-decoder crash.

OMP's custom-provider registration accepts a subset of its native model fields.
Fields outside that API need support in OMP before they can take effect; the
extension forwards them without adding its own restrictions.

## Development

```bash
pnpm install
pnpm run dev:node
pnpm run verify
```

## License

MIT
