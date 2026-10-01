# Run recording

`@floway-dev/dump` stores pipeline runs as encoded NDJSON and publishes completed
metadata. It owns recording contracts, stream recording, broker framing and the
portable recorder. Its dependencies are supplied by the application.

```ts
const recorder = createRunRecorder({
  write: record => store.put(keyId, record),
  publish: meta => broker.publish(keyId, meta),
});
const result = await run(chain, facts, { dump: recorder.sink });
await result.drain();
await recorder.finish(metadata);
```

The application owns drain/error handling and final metadata assembly, including
failed requests. Metadata is published after storage succeeds. An encoder failure
rejects completion with the original error so a partial object space is never
published as a completed record.

`recordStream` records frames before forwarding them. Only natural exhaustion
records the stream end marker; returning early or throwing leaves it incomplete.
The symbol-backed stream reference survives transport wrappers through
`streamReferenceOf`.

Pipeline events, object-space encoding/decoding, secrets and deferred values remain
in `@floway-dev/pipeline`. FileStore and LogStream contracts remain in
`@floway-dev/platform`. Gateway owns request admission, account/retention policy,
model attribution, HTTP measurement, SQL adapters and authenticated routes.

Use `/types` for browser metadata/record contracts and `/codec` for platform broker
composition. Run records contain facts and protocol frames.
