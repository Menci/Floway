// Alias resolution evaluates every target against the provider catalog on each
// request. A bounded list keeps an operator typo or corrupt row from turning
// one model id into unbounded request-time work while retaining ample room for
// deliberate multi-provider fallback policies.
export const MODEL_ALIAS_TARGET_LIMIT = 64;
