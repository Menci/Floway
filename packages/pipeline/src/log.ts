import { createLogg, getGlobalHookPostLog } from '@guiiai/logg';
import type { Log, Logger } from '@guiiai/logg';

import type { Emit } from './events.ts';

const record = (logger: Logger, stageId: number, emit: Emit): void => {
  const hook = (log: Log, formatted: string): void => {
    getGlobalHookPostLog()?.(log, formatted);
    emit({ type: 'log', stageId, ...log });
  };
  // Both output paths provide the formatted log, which the instance hook must forward to the global hook.
  // https://github.com/guiiai/logg/blob/191ed0f6c763fd49d402a3f936b29e6322396782/src/logger.ts#L483-L526
  // The patched child configuration inherits this instance hook.
  // https://github.com/guiiai/logg/blob/191ed0f6c763fd49d402a3f936b29e6322396782/src/logger.ts#L295-L311
  logger.withAfterLog(hook as (log: Log) => void);
};

export const stageLogger = (name: string, stageId: number, emit?: Emit): Logger => {
  const logger = createLogg(name).useGlobalConfig();
  if (emit) record(logger, stageId, emit);
  return logger;
};
