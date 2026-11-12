import type { TranslateInputError } from '../types.ts';

// Expected input failures are caught at the package's public operations. Internal
// reader and writer helpers can abort without spreading a result union through
// every intermediate transformation.
export class TranslateInputException extends Error {
  readonly failure: TranslateInputError;

  constructor(message: string, options?: Omit<TranslateInputError, 'type' | 'message'>) {
    super(message);
    this.name = 'TranslateInputException';
    this.failure = { type: 'input-error', message, ...options };
  }
}
