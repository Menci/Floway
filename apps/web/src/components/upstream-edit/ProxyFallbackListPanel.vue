<script setup lang="ts">
import { useNow } from '@vueuse/core';
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger,
  PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger,
} from 'reka-ui';
import { computed } from 'vue';

import type { ProxyFallbackEntry, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { formatCountdown } from '../../utils/format-countdown.ts';
import { Sortable, TagCombobox, Tooltip } from '@floway-dev/ui';

const BUILT_IN_TRANSPORTS = [
  { id: 'direct_fetch', label: 'DIRECT fetch()', title: 'Runtime-native fetch with automatic HTTP handling' },
  { id: 'direct_connect', label: 'DIRECT connect()', title: 'Raw TCP socket with userspace TLS and HTTP/1.1' },
] as const;

const isBuiltInTransport = (id: string): boolean => BUILT_IN_TRANSPORTS.some(transport => transport.id === id);

// Common CF colos for the combobox suggestion list. Not exhaustive — the
// editor still accepts free-form codes (Node RUNTIME_LOCATION tags can be
// arbitrary, and Cloudflare adds new colos faster than we want to track).
const COLO_OPTIONS = [
  'HKG', 'NRT', 'KIX', 'TPE', 'ICN', 'SIN', 'BKK', 'KUL',
  'LAX', 'SJC', 'SEA', 'DFW', 'ORD', 'IAD', 'EWR', 'YYZ',
  'LHR', 'CDG', 'AMS', 'FRA', 'MAD', 'MXP', 'WAW', 'ARN',
  'SYD', 'AKL', 'GRU', 'JNB', 'DXB', 'BOM', 'DEL',
].map(c => ({ value: c, label: c }));

const list = defineModel<ProxyFallbackEntry[]>({ required: true });

const props = defineProps<{
  // null in create mode; backoff rows need a saved upstream id.
  upstreamId: string | null;
  // When true the editor surfaces colo chips + popover + Current colo banner.
  // Wired off by callers running on Node (no anycast) so the irrelevant UI
  // never reaches operators who have no colo to scope to.
  coloAware: boolean;
  // The runtime's current colo, used for the cyan "current" highlight on
  // chips and as the toggle target in the popover. Null suppresses both.
  currentColo: string | null;
}>();

const { proxies, backoffsByProxyId } = useProxiesStore();

const proxiesById = computed<Map<string, ProxyRecord>>(() => {
  const map = new Map<string, ProxyRecord>();
  for (const p of proxies.value ?? []) map.set(p.id, p);
  return map;
});

const proxiesNotInList = computed<ProxyRecord[]>(() => {
  const used = new Set(list.value.map(e => e.id));
  return (proxies.value ?? []).filter(p => !used.has(p.id));
});

const builtInTransportsNotInList = computed(() => {
  const used = new Set(list.value.map(entry => entry.id));
  return BUILT_IN_TRANSPORTS.filter(transport => !used.has(transport.id));
});

const labelFor = (entry: ProxyFallbackEntry): string => {
  const builtIn = BUILT_IN_TRANSPORTS.find(transport => transport.id === entry.id);
  if (builtIn) return builtIn.label;
  return proxiesById.value.get(entry.id)!.name;
};

// True for entries that name a proxy id we don't know about — typically a
// row that was hand-removed from the proxies table after this upstream
// referenced it. We render these distinctively and let the operator
// remove them in one click instead of silently masquerading as a normal
// entry whose label happens to be a UUID.
const isOrphan = (entry: ProxyFallbackEntry): boolean =>
  !isBuiltInTransport(entry.id) && !proxiesById.value.has(entry.id);

const now = useNow({ interval: 1000 });

interface ActiveBackoff {
  expiresIn: string;
  failCount: number;
  lastError: string | null;
}

const activeBackoffByEntry = computed<Map<string, ActiveBackoff>>(() => {
  if (props.upstreamId === null) return new Map();
  const map = new Map<string, ActiveBackoff>();
  const nowSec = Math.floor(now.value.getTime() / 1000);
  for (const entry of list.value) {
    if (isBuiltInTransport(entry.id)) continue;
    const rows = backoffsByProxyId.value.get(entry.id);
    // `>=` keeps the entry's badge visible during its expiry second so the
    // countdown's `now` edge label is reachable; a strict `>` would hide it
    // before the displayed delta could hit zero.
    const row = rows?.find(r => r.upstream_id === props.upstreamId && r.expires_at >= nowSec);
    if (row) {
      map.set(entry.id, {
        expiresIn: formatCountdown((row.expires_at - nowSec) * 1000),
        failCount: row.fail_count,
        lastError: row.last_error,
      });
    }
  }
  return map;
});

const formatBackoffTooltip = (b: ActiveBackoff): string =>
  `Backoff active · ${b.expiresIn} remaining · ${b.failCount} fail${b.failCount === 1 ? '' : 's'}${b.lastError ? ` · ${b.lastError}` : ''}`;

const removeAt = (index: number) => {
  const next = [...list.value];
  next.splice(index, 1);
  list.value = next;
};

const moveUp = (index: number) => {
  if (index <= 0) return;
  const next = [...list.value];
  const tmp = next[index]!;
  next[index] = next[index - 1]!;
  next[index - 1] = tmp;
  list.value = next;
};

const moveDown = (index: number) => {
  if (index >= list.value.length - 1) return;
  const next = [...list.value];
  const tmp = next[index]!;
  next[index] = next[index + 1]!;
  next[index + 1] = tmp;
  list.value = next;
};

const append = (id: string) => {
  list.value = [...list.value, { id }];
};

const normalizeColos = (raw: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw) {
    const v = c.trim().toUpperCase();
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

const setColosAt = (index: number, colos: string[]) => {
  const entry = list.value[index]!;
  const normalized = normalizeColos(colos);
  const next = [...list.value];
  next[index] = normalized.length === 0 ? { id: entry.id } : { id: entry.id, colos: normalized };
  list.value = next;
};

const toggleCurrentColoAt = (index: number) => {
  if (!props.currentColo) return;
  const entry = list.value[index]!;
  const current = entry.colos ?? [];
  if (current.includes(props.currentColo)) {
    setColosAt(index, current.filter(c => c !== props.currentColo));
  } else {
    setColosAt(index, [...current, props.currentColo]);
  }
};
</script>

<template>
  <section>
    <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
      Proxy Fallback List <span class="text-accent-cyan">({{ list.length }})</span>
      <span v-if="coloAware && currentColo" class="ml-2 font-mono text-gray-500">
        · this colo = <span class="text-accent-cyan">{{ currentColo }}</span>
      </span>
    </p>

    <div v-if="list.length === 0" class="rounded-md border border-dashed border-white/[0.08] bg-surface-900/40 px-3 py-2.5 text-xs text-gray-500">
      No fallback list configured — defaults to DIRECT fetch().
    </div>

    <Sortable
      v-else
      v-model="list"
      tag="ul"
      handle=".drag-handle"
      class="divide-y divide-white/[0.06]"
      :item-key="(e: ProxyFallbackEntry) => e.id"
    >
      <template #default="{ item: entry, index }: { item: ProxyFallbackEntry; index: number }">
        <li class="flex items-center gap-2 px-1 py-2 text-sm">
          <button
            type="button"
            class="drag-handle inline-flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-gray-300 active:cursor-grabbing"
            aria-label="Drag to reorder"
            title="Drag to reorder"
          >
            <i class="i-lucide-grip-vertical size-3.5" />
          </button>

          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              class="min-w-0 truncate"
              :class="[
                isBuiltInTransport(entry.id) ? 'font-mono text-gray-300' : (isOrphan(entry) ? 'font-mono text-accent-rose' : 'text-white'),
              ]"
              :title="BUILT_IN_TRANSPORTS.find(transport => transport.id === entry.id)?.title ?? entry.id"
            >
              <template v-if="isOrphan(entry)">Unknown proxy · {{ entry.id }}</template>
              <template v-else>{{ labelFor(entry) }}</template>
            </span>

            <PopoverRoot v-if="coloAware">
              <PopoverTrigger as-child>
                <button
                  type="button"
                  class="inline-flex max-w-full flex-wrap items-center gap-1 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-cyan/40"
                  :title="entry.colos?.length ? 'Click to edit colo whitelist' : 'Click to limit this entry to specific colos'"
                >
                  <span
                    v-if="!entry.colos?.length"
                    class="rounded-md border border-dashed border-white/[0.14] px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                  >All colos</span>
                  <template v-else>
                    <span
                      v-for="c in entry.colos"
                      :key="c"
                      class="inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors"
                      :class="currentColo && currentColo === c
                        ? 'border-accent-cyan bg-surface-900 text-accent-cyan shadow-[0_0_8px_rgba(0,229,255,0.45)]'
                        : 'border-white/[0.1] bg-surface-600 text-gray-200'"
                    >{{ c }}</span>
                  </template>
                </button>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent
                  :side-offset="6"
                  align="start"
                  class="z-50 w-80 rounded-[10px] border border-white/[0.08] bg-surface-800 p-3 shadow-xl"
                >
                  <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                    Colo whitelist
                  </p>

                  <TagCombobox
                    :model-value="entry.colos ?? []"
                    :items="COLO_OPTIONS"
                    :highlight="currentColo ? [currentColo] : []"
                    placeholder="HKG, NRT, AMS…"
                    empty-text="Type a 3-letter colo code and press Enter to add"
                    @update:model-value="(v: string[]) => setColosAt(index, v)"
                  />

                  <p class="mt-2 text-[10px] text-gray-500">
                    Empty = active in <span class="text-gray-300">all colos</span>.
                    Free-form codes accepted; suggestions are common CF colos.
                  </p>

                  <div class="mt-2 flex items-center gap-2 border-t border-white/[0.06] pt-2 text-[10px] text-gray-500">
                    <span>Current colo:</span>
                    <button
                      v-if="currentColo"
                      type="button"
                      class="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium transition-all"
                      :class="(entry.colos ?? []).includes(currentColo)
                        ? 'border-accent-cyan bg-surface-900 text-accent-cyan shadow-[0_0_8px_rgba(0,229,255,0.45)] hover:shadow-[0_0_12px_rgba(0,229,255,0.6)]'
                        : 'border-dashed border-white/[0.2] bg-transparent text-gray-400 hover:border-accent-cyan/50 hover:text-accent-cyan'"
                      @click="toggleCurrentColoAt(index)"
                    >{{ currentColo }}</button>
                    <span v-else class="italic">unknown</span>
                    <span class="italic">(click to toggle)</span>
                  </div>

                  <PopoverArrow class="fill-surface-800" :width="10" :height="5" />
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
          </div>

          <div class="flex shrink-0 items-center gap-0.5">
            <Tooltip
              v-if="activeBackoffByEntry.get(entry.id)"
              :content="formatBackoffTooltip(activeBackoffByEntry.get(entry.id)!)"
            >
              <span
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-accent-amber transition-colors hover:bg-white/[0.04]"
                :aria-label="formatBackoffTooltip(activeBackoffByEntry.get(entry.id)!)"
              >
                <i class="i-lucide-triangle-alert size-3.5" />
              </span>
            </Tooltip>

            <Tooltip content="Move up">
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                :disabled="index === 0"
                aria-label="Move entry up"
                @click="moveUp(index)"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
            </Tooltip>

            <Tooltip content="Move down">
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                :disabled="index === list.length - 1"
                aria-label="Move entry down"
                @click="moveDown(index)"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </Tooltip>

            <Tooltip content="Remove">
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
                aria-label="Remove entry"
                @click="removeAt(index)"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </Tooltip>
          </div>
        </li>
      </template>
    </Sortable>

    <div class="mt-2">
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          class="inline-flex h-9 w-full items-center justify-between rounded-[10px] border border-white/[0.06] bg-surface-700 px-3 text-sm text-gray-300 transition-colors hover:border-white/[0.1] focus:border-accent-cyan/50 focus:outline-none focus:ring-1 focus:ring-accent-cyan/30"
        >
          <span>+ Add entry</span>
          <svg class="size-4 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="start"
            :side-offset="4"
            class="z-50 w-[var(--reka-dropdown-menu-trigger-width)] min-w-[8rem] overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 p-1 text-white shadow-xl"
          >
            <DropdownMenuItem
              v-for="transport in builtInTransportsNotInList"
              :key="transport.id"
              class="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 font-mono text-sm text-gray-300 outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan"
              :title="transport.title"
              @select="append(transport.id)"
            >
              {{ transport.label }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-for="p in proxiesNotInList"
              :key="p.id"
              class="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm text-white outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan"
              @select="append(p.id)"
            >
              {{ p.name }}
            </DropdownMenuItem>
            <p
              v-if="proxiesNotInList.length === 0 && builtInTransportsNotInList.length === 0"
              class="px-2 py-1.5 text-xs text-gray-500"
            >
              All entries already added.
            </p>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>
  </section>
</template>
