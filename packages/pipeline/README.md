# Pipeline

The pipeline package runs named arrays of stages over immutable facts. It has
no gateway, provider, transport or repository dependency.

## Facts and stages

Use `move(value)` when handing object values into facts. It freezes ordinary
data in place, preserving shared descendants. Typed arrays and native streams
retain their platform implementation; they are registered as handed over
without being frozen. Represent uploaded Blob/File content with bytes and its
metadata before handing it over:

```ts
const upload = move({
  name: file.name,
  type: file.type,
  lastModified: file.lastModified,
  bytes: new Uint8Array(await file.arrayBuffer()),
});
```

A stage declares where control can go:

- `return` answers with its declared `provides` keys.
- `through` calls the remaining stages.
- `into` is last and may name another pipeline when calling `next`.

Request and response declarations name `needs`, `consumes` and `provides`.
Assembly derives the pipeline entry needs and checks ordering. Execution checks
each declared need, provided key and consumed key. Declarations do not rewrite
the record. A return-only stage has no request declaration, so its author must
express its input contract in its type.

## Lifetime and failures

`own(value, release)` claims a resource and installs an idempotent asynchronous
disposer. The same disposal promise is awaited by manual disposal and the
runner. Consumed resources are released when their stage hands up; retained
resources belong to the run until `drain()`.

`setRelease(resource, release)` changes how that same resource is released
before disposal starts. An HTTP body can initially be cancellable, then acquire
the decoder's drain action without a second ownership claim.
It returns the prior release callback so a later layer can compose its own
settlement around that callback without recursively invoking the disposer.

`defer(promise)` marks work the run must finish. Initial facts and all later
handovers register owned and deferred values. `drain()` waits for their
completion and propagates failures. Resource and request contracts own their
cancellation semantics; the runner imposes no wall-clock deadline on declared
work. Concurrent callers share the same drain promise.

A programming exception keeps its original error object. `getFailureFacts(error)`
returns the deepest accepted facts associated with that failure. If cleanup
also fails, an `AggregateError` preserves the original exception as its cause
and retains every cleanup error. Cleanup still attempts the other resources.

## Run recording

Recording is enabled by a `dump` sink in the run's services. Events carry stage
boundaries, stage logs, protocol frames and deferred settlement. Encoding
assigns object IDs, retains shared references and interns large equal strings.
Each encoded event is one NDJSON line. The runner delivers events directly
to the sink and returns only facts and the drain operation; it retains no
parallel event backlog. A caller that needs an in-memory collection can collect
from that sink explicitly.

Special values remain distinguishable from ordinary data:

- Recorded protocol streams use `$stream` IDs; frames and termination name that
  ID.
- Native `ReadableStream` values use `$readableStream` handles. Their raw HTTP
  bytes are not recorded by this package.
- Deferred values use `$deferred` handles. A `deferred.settled` event names the
  same reference and carries a fulfilled value or rejected error.
- Errors use `$error` with name, message, stack, cause and other own properties.
- Array buffers and their views use `$bytes`, shared by their complete byte
  value. Maps, sets and dates use `$map`, `$set` and `$date` tags; their content
  retains shared references. Unsupported JSON scalars have explicit tags.
- `Secret` values retain length and a stable hash while masking their complete
  rendered value. Other strings are stored verbatim.

Native Blob/File values cannot be read synchronously by the encoder and are
rejected rather than recorded as empty objects. Their portable bytes and
metadata representation records losslessly through the ordinary value codec.

`createRunReader()` accepts each stored event and resolves its facts, frames or
deferred outcome in the same object space. Cycles and shared descendants retain
their decoded identities. `read.node(id)` exposes the stored node for structural
inspection; `read.decode(value)` uses that same cache, and
`read.settlement(id)` returns a deferred handle's observed outcome. Bytes,
collections, errors and platform handles decode to content descriptions so
reading a dump does not recreate live resources.
