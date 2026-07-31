import type { DumpErrorMeta, DumpMetadata } from '@floway-dev/gateway/dump-types';

export type RequestSeverity = 'success' | 'warning' | 'error';

export function requestSeverity(status: number | null, error: DumpErrorMeta | null): RequestSeverity {
  if (status === null || error !== null || status >= 500) return 'error';
  if (status >= 400) return 'warning';
  return 'success';
}

export function errorLabel(error: DumpErrorMeta | null, status: number | null): string | null {
  if (!error) return null;
  if (error.kind === 'failed') return error.reason;
  return `${error.kind} error ${status === null || status === 0 ? '???' : status}`;
}

export function totalTokens(meta: DumpMetadata): number | null {
  if (meta.inputTokens === null && meta.outputTokens === null) return null;
  return (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${formatNumber(value / 1024, value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 ** 3) return `${formatNumber(value / 1024 ** 2, value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${formatNumber(value / 1024 ** 3, 2)} GB`;
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

const formatNumber = (value: number, maximumFractionDigits: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
