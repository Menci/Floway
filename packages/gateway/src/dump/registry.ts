import type { DumpStore } from './store-contract.ts';
import { DUMP_DISABLED_REASON, type DumpBroker } from '@floway-dev/dump';

let _store: DumpStore | null = null;
let _broker: DumpBroker | null = null;

export const initDumpStore = (store: DumpStore): void => {
  _store = store;
};

export const getDumpStore = (): DumpStore => {
  if (!_store) throw new Error('DumpStore not initialized — call initDumpStore() first');
  return _store;
};

export const initDumpBroker = (broker: DumpBroker): void => {
  _broker = broker;
};

export const getDumpBroker = (): DumpBroker => {
  if (!_broker) throw new Error('DumpBroker not initialized — call initDumpBroker() first');
  return _broker;
};

// Best-effort by contract: a broker outage must never fail the surrounding
// write, since clients reconcile on the next reconnect/refetch.
export const notifyDisabledBestEffort = async (keyId: string, where: string): Promise<void> => {
  try {
    await getDumpBroker().closeChannel(keyId, DUMP_DISABLED_REASON);
  } catch (err) {
    console.error(`[dump] closeChannel failed during ${where}`, keyId, err);
  }
};
