# Run recording

`@floway-dev/dump` owns the portable run writer, protocol-stream references,
metadata contracts, broker framing and wire conversion. Pipeline owns stage
execution and object-space encoding/reading. Platform owns FileStore, LogStream
and their transport bindings. Gateway supplies fixed ports and owns request
admission, identity generation, account/retention policy, model attribution,
owned-work drain, HTTP measurement, SQL adapters and authenticated routes.

## Recorder lifetime

There is one streaming recorder. The application supplies the run ID and start
time; storage receives an encoded byte stream and a promise for final metadata.
The writer serializes each event's complete object batch, so concurrent deferred
outcomes cannot overtake the objects they reference. Batches are emitted in at
most 64 KiB byte chunks. Durable consumption applies backpressure to execution.

```ts
const recorder = createRunRecorder({
  id,
  startedAt,
  write: run => store.putRun(keyId, run),
  publish: meta => broker.publish(keyId, meta),
  openLive: () => liveStore.open(runStreamId(keyId, id)),
  background,
});
const result = await run(chain, facts, { dump: recorder.sink });
await recorder.finish(async () => {
  await finishOwnedWork(result.drain);
  await recorder.flush();
  return buildMetadata();
});
```

The application handles drain failures and assembles its business metadata in
the finish callback. `flush` awaits the current encoded event tail, allowing the
completion timestamp and attribution to follow all owned work and writes. The
callback runs inside the recorder's abort boundary. Encoding or metadata failures
abort the native durable reader and retain their original error. Cleanup failures
retain the original error in an AggregateError chain.

The artifact is published before broker notification; notification must succeed
before clean live EOF. A notification failure retains the stored artifact and
rejects completion with its original error. Background storage failures are
observed even before finish begins. Failed recordings stop their heartbeat,
including a live carrier that opens after the failure.

## Transient bytes

Durable and live readers receive identical NDJSON bytes. A live append retries
three times at its original position, so a lost acknowledgement cannot duplicate
content. Persistent live failure is reported while durable recording continues.
Empty heartbeats use the acknowledged position independently of the data tail;
a blocked durable reader cannot expire an otherwise active writer. Completion
awaits any in-flight heartbeat before ending the carrier.

`runStreamId(scopeId, runId)` shares the writer/reader namespace. The application
owns scope authorization. FileStore stages complete atomic objects; the SQL
adapter renews unfinished file leases and publishes completed rows. Storage
failures leave unfinished artifacts eligible for cleanup.

## Protocol references and readers

`recordStream` records frames before forwarding the same source values. Only
natural exhaustion records the stream end marker; returning early or throwing
leaves it incomplete. Its nullable projector excludes transport-only values
without removing those values from the source. `streamReferenceOf` carries the
same Symbol-backed reference across transport wrappers.

Use `/types` for browser metadata and record contracts and `/codec` for platform
broker composition. `StoredDumpRecord` contains completed bytes; `DumpRunWrite`
contains the writer-owned stream and deferred metadata. Run records contain
facts and protocol frames in the pipeline object space. Live discovery,
reconnection and list interaction are separate application work.
