import type { DumpStore } from './store-contract.ts';

let _store: DumpStore | null = null;

export const initDumpStore = (store: DumpStore): void => {
  _store = store;
};

export const getDumpStore = (): DumpStore => {
  if (!_store) throw new Error('DumpStore not initialized — call initDumpStore() first');
  return _store;
};
