// Routing-side API name primitives shared across the data plane.
//
// `NonLlmServeApiName` is the set of API names that bypass the LLM
// source-routing graph entirely. These run on the passthroughServe helper
// (see ./passthrough-serve.ts) instead of the LLM source/target executors,
// which exclude this set from their own PerformanceApiName subsets through
// `Exclude<PerformanceApiName, NonLlmServeApiName>`. The values overlap
// with PerformanceApiName by construction — telemetry treats both LLM and
// passthrough sources uniformly under one column domain.
export type NonLlmServeApiName = 'embeddings' | 'images_generations' | 'images_edits';
