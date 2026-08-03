import type { DumpErrorMeta, DumpMetadata } from '@floway-dev/gateway/dump-types';

export type RequestSeverity = 'success' | 'warning' | 'error';

export const requestSeverity = (status: number | null, error: DumpErrorMeta | null): RequestSeverity => {
  if (status === null || error !== null || status >= 500) return 'error';
  if (status >= 400) return 'warning';
  return 'success';
};

// The status joins the label only where the caller has nowhere else to carry
// it. The detail panel renders an HttpStatusBadge beside the label, so it omits
// the argument and gets the bare kind.
export const errorLabel = (error: DumpErrorMeta | null, status?: number | null): string | null => {
  if (!error) return null;
  if (error.kind === 'failed') return error.reason;
  if (status === undefined) return `${error.kind} error`;
  return `${error.kind} error ${status === null || status === 0 ? '???' : status}`;
};

export const totalTokens = (meta: DumpMetadata): number | null => {
  if (meta.inputTokens === null && meta.outputTokens === null) return null;
  return (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
};
