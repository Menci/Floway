// Tunable constants exposed to consumers that don't want to pull the dial
// runtime. Values live here rather than on dialer.ts so importing a
// constant doesn't drag the protocol runners and TLS stack into the
// consumer's bundle.

// Hard ceiling on the time the dial layer is allowed to spend before
// callers should give up on this entry. Covers TCP connect + outer-TLS +
// proxy-handshake (everything that happens inside dial()); once dial()
// returns, inner-TLS and the upstream response are unbounded by this knob.
// 10s keeps a black-holed entry from stalling the call: a healthy
// outer-TCP + outer-TLS + proxy-handshake round-trip finishes well under
// that even on latency-bound links. Override per call by passing
// options.dialTimeoutMs to runProxiedRequest.
export const DEFAULT_DIAL_DEADLINE_MS = 10_000;
