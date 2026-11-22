import { sumBillableUsage, type BillableUsage } from '@floway-dev/protocols/common';
import type { PerformanceTelemetryContext, TelemetryModelIdentity } from '@floway-dev/provider';

export interface ChatUsageEntry {
  readonly modelIdentity: TelemetryModelIdentity;
  readonly performance?: PerformanceTelemetryContext;
  readonly billableUsage?: BillableUsage;
}

type ChatUsageEntryUpdate = Omit<ChatUsageEntry, 'billableUsage'> & {
  readonly billableUsage?: BillableUsage;
};

export class ChatUsageLedger {
  readonly #entries = new Map<string, ChatUsageEntry>();
  #nextId = 1;

  register(entry: ChatUsageEntryUpdate): string {
    const usageId = `usage_${this.#nextId++}`;
    this.#entries.set(usageId, copyEntry(entry));
    return usageId;
  }

  updateBillableUsage(usageId: string, billableUsage: BillableUsage): void {
    const entry = this.#require(usageId);
    this.#entries.set(usageId, { ...entry, billableUsage });
  }

  accumulateBillableUsage(usageId: string, billableUsage: BillableUsage | undefined): void {
    if (billableUsage === undefined) return;
    const entry = this.#require(usageId);
    const accumulated = sumBillableUsage(entry.billableUsage, billableUsage);
    if (accumulated !== undefined) this.#entries.set(usageId, { ...entry, billableUsage: accumulated });
  }

  setEntry(usageId: string, entry: ChatUsageEntryUpdate): void {
    this.#require(usageId);
    this.#entries.set(usageId, copyEntry(entry));
  }

  read(
    usageId: string | undefined,
    fallback: Pick<ChatUsageEntry, 'modelIdentity' | 'performance'>,
  ): ChatUsageEntry {
    if (usageId === undefined) return copyEntry(fallback);
    return copyEntry(this.#require(usageId));
  }

  #require(usageId: string): ChatUsageEntry {
    const entry = this.#entries.get(usageId);
    if (entry === undefined) throw new Error(`Unknown chat usage id: ${usageId}`);
    return entry;
  }
}

const copyEntry = (entry: ChatUsageEntryUpdate): ChatUsageEntry => ({
  modelIdentity: entry.modelIdentity,
  ...(entry.performance === undefined ? {} : { performance: entry.performance }),
  ...(entry.billableUsage === undefined ? {} : { billableUsage: entry.billableUsage }),
});
