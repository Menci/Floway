# Platform contracts

This package defines portable runtime services. Implementations live in the
platform applications; runtime composition installs them through the exported
initializers.

## Stored files

`FileStore.put(key, bytes)` stores a complete `Uint8Array`. `get` returns the
stored bytes or null, and `deleteKeys` removes exact keys. Node uses the
configured filesystem directory, Cloudflare uses R2, and the in-memory
implementation stores byte copies.

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
empty heartbeat, and read progress renew it. To keep a quiet active stream open, its writer sends empty
appends while work is pending; a completed or abandoned stream is
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
