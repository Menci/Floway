import { HttpTransportError } from '@floway-dev/http';
import { ProxyDialError } from '@floway-dev/proxy';

export const isUpstreamTransportError = (error: unknown): error is Error =>
  error instanceof HttpTransportError
  || (error instanceof ProxyDialError && error.stage !== 'config')
  || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isUpstreamTransportError));
