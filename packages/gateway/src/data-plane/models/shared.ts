// Squash genuine upstream HTTP/parse failures (ProviderModelsUnavailableError)
// to a generic 502 so we do not leak upstream identity. Other errors (e.g.
// the registry's "no upstream configured" hint) carry actionable operator
// guidance and surface verbatim.
export const MODEL_LISTING_FAILURE_MESSAGE = 'Upstream model listing failed';

// The message says nothing about the upstream and is prose, so control-plane
// bodies carry this code beside it: the dashboard tells this failure apart from
// an arbitrary one without matching English.
export const MODEL_LISTING_FAILURE_CODE = 'upstream_model_listing_failed';
