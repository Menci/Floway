// Squash genuine upstream HTTP/parse failures (ProviderModelsUnavailableError)
// to a generic 502 so we do not leak upstream identity. Other errors (e.g.
// the registry's "no upstream configured" hint) carry actionable operator
// guidance and surface verbatim.
export const MODEL_LISTING_FAILURE_MESSAGE = 'Upstream model listing failed';

// The message says nothing about the upstream and is prose, so the upstream
// list-models route pairs it with this code and the dashboard tells that
// failure apart from an arbitrary one without matching English. The model-list
// endpoints stay message-only: /v1/models, /models and /api/models answer a
// listing failure identically.
export const MODEL_LISTING_FAILURE_CODE = 'upstream_model_listing_failed';
