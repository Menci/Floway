// The synchronous control-plane Fetch Models action squashes upstream
// HTTP/parse failures to this generic message so provider identity stays
// private. Ordinary listing routes read persisted snapshots and never observe
// the triggered upstream failure in their request lifecycle.
export const MODEL_LISTING_FAILURE_MESSAGE = 'Upstream model listing failed';

// The message says nothing about the upstream and is prose, so the upstream
// catalog action pairs it with this code and the dashboard tells that
// failure apart from an arbitrary one without matching English. The model-list
// snapshot listing routes do not use this action-specific discriminator.
export const MODEL_LISTING_FAILURE_CODE = 'upstream_model_listing_failed';
