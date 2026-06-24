// Routing-side API name primitives shared across the data plane.
//
// `PassthroughServeApiName` is the set of API names served by the
// passthroughServe helper (see ./passthrough-serve.ts) rather than the
// LLM source/target executor. It groups by transport shape (the body /
// frames are forwarded verbatim, possibly with a usage-extraction
// step), not by whether the endpoint is "LLM" — `/v1/completions` is
// an LLM endpoint that lives here because there is nothing to
// translate to or from.
export type PassthroughServeApiName = 'completions' | 'embeddings' | 'images_generations' | 'images_edits';
