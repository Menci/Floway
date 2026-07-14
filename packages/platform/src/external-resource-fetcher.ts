export type ExternalResourceFetcher = (
  url: URL,
  signal: AbortSignal,
) => Promise<Response>;

let externalResourceFetcher: ExternalResourceFetcher | null = null;

export const initExternalResourceFetcher = (fetcher: ExternalResourceFetcher): void => {
  externalResourceFetcher = fetcher;
};

export const getExternalResourceFetcher = (): ExternalResourceFetcher => {
  if (externalResourceFetcher === null) {
    throw new Error('External resource fetcher not initialized — call initExternalResourceFetcher() first');
  }
  return externalResourceFetcher;
};
