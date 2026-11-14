// Google RPC status names for the HTTP error codes used by this protocol.
// https://ai.google.dev/api/rest/v1beta/Status
const HTTP_ERROR_STATUSES = new Map<number, string>([
  [400, 'INVALID_ARGUMENT'],
  [401, 'UNAUTHENTICATED'],
  [403, 'PERMISSION_DENIED'],
  [404, 'NOT_FOUND'],
  [408, 'DEADLINE_EXCEEDED'],
  [409, 'ABORTED'],
  [429, 'RESOURCE_EXHAUSTED'],
  [500, 'INTERNAL'],
  [501, 'UNIMPLEMENTED'],
  [502, 'UNAVAILABLE'],
  [503, 'UNAVAILABLE'],
  [504, 'DEADLINE_EXCEEDED'],
]);

export const geminiGenerateContentStatusForHttpStatus = (status: number): string | undefined => HTTP_ERROR_STATUSES.get(status);
