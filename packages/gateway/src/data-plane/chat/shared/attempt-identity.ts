import type { AttemptSelector } from '../../pipeline/facts.ts';

/** How the attempt whose usage is being read is named in the errors the fold raises: an
 *  operator is told which upstream and which model to set the flag on. */
export const attemptIdentity = (attempt: AttemptSelector): string => `${attempt.upstreamId}/${attempt.modelId}`;
