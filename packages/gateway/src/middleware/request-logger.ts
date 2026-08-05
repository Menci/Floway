import type { MiddlewareHandler } from 'hono';

type Print = (message: string) => void;

const formatElapsed = (start: number): string => {
  const elapsed = Date.now() - start;
  const value = elapsed < 1_000 ? `${elapsed}ms` : `${Math.round(elapsed / 1_000)}s`;
  return value.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1,');
};

const printToConsole: Print = message => console.log(message);

// Hono's logger deliberately includes the query string in both request lines:
// https://github.com/honojs/hono/blob/2f01b774b168911d24e4864fb66054f5de9d9a4e/src/middleware/logger/index.ts#L81-L93
// Query parameters can carry credentials, so the request log is built only
// from Hono's parsed pathname and never observes the full URL.
export const requestLogger = (print: Print = printToConsole): MiddlewareHandler => async (c, next) => {
  const { method, path } = c.req;
  print(`<-- ${method} ${path}`);

  const start = Date.now();
  await next();

  print(`--> ${method} ${path} ${c.res.status} ${formatElapsed(start)}`);
};
