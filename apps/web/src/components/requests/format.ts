export type RequestSeverity = 'success' | 'warning' | 'error';

export const requestSeverity = (status: number | null, error: string | null): RequestSeverity => {
  if (status === null || error !== null || status >= 500) return 'error';
  if (status >= 400) return 'warning';
  return 'success';
};
