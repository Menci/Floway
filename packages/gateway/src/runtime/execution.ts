import type { ExecutionCellNamespace } from '@floway-dev/platform';

let executionCells: ExecutionCellNamespace | null = null;

export const initExecutionCellNamespace = (namespace: ExecutionCellNamespace): void => {
  executionCells = namespace;
};

export const getExecutionCellNamespace = (): ExecutionCellNamespace => {
  if (executionCells === null) throw new Error('Execution cell namespace not initialized');
  return executionCells;
};
