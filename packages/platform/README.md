# Platform contracts

This package defines portable runtime services. Implementations live in the
platform applications; runtime composition installs them through the exported
initializers.

## Durable file writes

`FileStore.put(key, body)` accepts bytes or a `ReadableStream<Uint8Array>`.
It consumes the stream with storage backpressure and publishes the complete
object at EOF. Until then, readers see the previous value or a missing key.
Failures preserve the prior object and expose the original error; cleanup
failures retain it in the error chain. `get` still returns complete bytes.

Node writes to a same-directory staging file and atomically renames it after
closing. Cloudflare uses bounded 5 MiB multipart parts for unknown-length
streams, since R2's single put requires a known length. Short and empty streams
use a single byte put. A storage/source failure cancels the source and cleans
up unfinished multipart state; live-view degradation does not affect this path.
The in-memory implementation collects bytes as part of its storage semantics.

## Transient run streams

`LogStreamStore.open(id)` asynchronously creates or opens a writer's stream.
`get(id)` attaches to existing state and returns null when it is missing or has
expired. Readers cannot accidentally create an empty stream that waits forever.

A `LogStream` contains bytes, independent of any event format:

- `append(offset, bytes)` writes only the suffix beyond the current length.
  Overlap is assumed identical; a hole raises `LogStreamHoleError`.
- `end()` seals new bytes and lets readers complete. Duplicate append retries
  remain valid; extending an ended stream raises `LogStreamEndedError`.
- `read(offset, signal)` follows the tail from a byte offset. Completion means
  the stream ended; cancellation or expiry interrupts the read.

`LOG_STREAM_IDLE_MS` is the shared idle lease. Append activity, including an
empty heartbeat, and read progress renew it. A quiet active writer sends empty
appends while upstream work is pending; a completed or abandoned stream is
reclaimed after idle activity stops. Existing handles then raise
`LogStreamExpiredError`. Expiration affects transient live viewing; the durable
artifact is a separate writer-owned path.

Node stores append-only segments in its process boundary and copies only new
bytes. Cloudflare uses one SQLite-backed Durable Object per stream, with
hibernatable WebSockets for tail notifications and alarms for reclamation.
Readers fetch one SQL segment per pull, so a paused consumer holds no backlog
in the Worker isolate. Actual consumption renews the reader lease.
Known RPC outcomes are data so the client reconstructs the same portable errors
without relying on remote custom Error prototypes.

## HTTP reader framing

`serveLogStream` and `readLogStream` use big-endian four-byte chunk lengths and a
zero-length terminator. The serving side pulls with downstream backpressure.
An interrupted read omits the terminator; the decoder rejects a missing
terminator or incomplete frame as `LogStreamTruncatedError`. No byte value is
reserved inside the stream content.
