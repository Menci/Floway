// Routing-side API name primitives shared across the data plane.
//
// `NonLlmServeApiName` is the set of API names that bypass the LLM
// source-routing graph entirely. These run on the passthroughServe helper
// (see ./passthrough-serve.ts) instead of the LLM source/target executors.
export type NonLlmServeApiName = 'embeddings' | 'images_generations' | 'images_edits' | 'completions';
