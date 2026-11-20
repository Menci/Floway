// Identity used by control-plane probes that run before an upstream row exists
// (draft model previews, Copilot/Claude/ChatGPT/Kimi/Ollama edit forms). The
// id is synthetic by construction: persisted upstreams are minted with
// shortId('up'), so no saved row can legitimately carry it.
//
// Backoff bookkeeping must skip this id. A failed dial during a draft probe
// used to persist a proxy_upstream_backoffs row keyed by 'draft'; nothing ever
// cleaned it up, and the dashboard's backoff listing threw on the orphan row
// forever after, because it requires every row to name a real upstream.
export const DRAFT_UPSTREAM_ID = 'draft';

export const isDraftUpstreamId = (upstreamId: string): boolean => upstreamId === DRAFT_UPSTREAM_ID;
