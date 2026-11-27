// Copilot selects the fast variant by its model id and rejects service_tier on the body.
// https://github.com/openai/codex/issues/32191
export const withoutServiceTier = <Payload extends { model: string; service_tier?: unknown }>(payload: Payload): Payload => {
  if (!('service_tier' in payload)) return payload;
  const { service_tier: _tier, ...rest } = payload;
  return rest as Payload;
};
