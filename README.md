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

## Development

```bash
pnpm install
pnpm run dev:node
```

Pipeline owns the stage-event format and object-space encoding. `@floway-dev/dump` owns
run recording, stream references, durable NDJSON writing, transient byte streams and metadata
publication. Gateway supplies storage/broker ports and applies request admission, model
attribution, HTTP byte measurement and retention policy. Credential-redacted encoded batches flow to durable
storage with backpressure and to a LogStream at the same byte positions. Three same-offset
append attempts tolerate lost acknowledgements; persistent live failure leaves durable
recording active. Empty heartbeats renew the acknowledged position independently of a
blocked durable writer.

Closing waits for owned readers, deferred outcomes and queued events before assembling
metadata. The artifact and metadata notification are published before the live stream ends.
Encoding, metadata or publication failures abort incomplete writes, stop leases and retain
original errors. Run IDs are assigned at entry; listing remains ordered by completion time
and ID. The Collected view uses the selected recorded client stream and its `stream.end`
event to establish recording completion.

The authenticated `GET /api/dump/keys/:keyId/records/:recordId/live?offset=0` endpoint attaches
to an existing per-key stream through the platform framed byte protocol. Active-run
discovery, reconnect/list semantics and live dashboard interactions remain separate design
work; completed records retain the same run-only format.

## License

MIT
