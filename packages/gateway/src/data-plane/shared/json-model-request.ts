// Preflight shared by the JSON passthrough endpoints. Each of them accepts an
// arbitrary JSON object and forwards it upstream verbatim, so the only field
// the gateway insists on is a non-empty `model` string — routing depends on
// it. `requestName` prefixes the 400 messages so each endpoint names itself.

interface JsonModelRequestBody {
  model?: unknown;
  [key: string]: unknown;
}

type PreparedJsonRequest =
  | { type: 'ok'; body: Record<string, unknown>; model: string }
  | { type: 'invalid'; message: string };

export const prepareJsonModelRequest = (bytes: Uint8Array, requestName: string): PreparedJsonRequest => {
  let request: JsonModelRequestBody;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { type: 'invalid', message: `${requestName} request body must be an object.` };
    }
    request = parsed as JsonModelRequestBody;
  } catch {
    return { type: 'invalid', message: `${requestName} request body must be valid JSON.` };
  }
  if (typeof request.model !== 'string' || request.model.length === 0) {
    return { type: 'invalid', message: `${requestName} request body must include a model string.` };
  }
  return { type: 'ok', body: request as Record<string, unknown>, model: request.model };
};
