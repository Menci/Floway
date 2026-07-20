// Routing-side API name primitives shared across the data plane.
//
// `PassthroughServeApiName` is the set of API names served by the
// passthroughServe helper (see ./passthrough-serve.ts) rather than the
// chat source/target executor. It groups by transport shape (the body /
// frames are forwarded verbatim, possibly with a usage-extraction step),
// not by whether the endpoint is chat-shaped — `/completions` is a
// non-chat endpoint that lives here because there is nothing to translate
// to or from. The value is the public URL fragment, so it can be used
// directly in error messages and route comparisons without a lookup table.
export type PassthroughServeApiName = '/completions' | '/embeddings' | '/images/generations' | '/images/edits' | '/audio/transcriptions';
