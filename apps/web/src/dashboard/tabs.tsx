import { html } from 'hono/html';

function spinner(cls: string) {
  return html`
    <svg class="animate-spin ${cls}" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25" />
      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75" />
    </svg>
  `;
}

function usageSummaryMetric(metric: string, label: string, valueExpression: string, skeletonWidth: string) {
  return html`
    <button
      type="button"
      @click="switchTokenChartMetric('${metric}')"
      class="text-center w-full rounded-md border border-transparent cursor-pointer transition-colors hover:border-white/10 focus:outline-none focus-visible:border-accent-cyan/40 px-2 py-2"
      :aria-pressed="tokenChartMetric === '${metric}'"
      title="Use ${label} for chart y-axis"
    >
      <span class="block text-xs mb-1" :class="tokenChartMetric === '${metric}' ? 'text-accent-cyan' : 'text-gray-500'">${label}</span>
      <template x-if="tokenLoading && !chartsReady">
        <span class="block h-7 ${skeletonWidth} mx-auto bg-surface-600 rounded animate-pulse"> </span>
      </template>
      <template x-if="!tokenLoading || chartsReady">
        <span class="block text-lg font-bold font-mono" :class="tokenChartMetric === '${metric}' ? 'text-accent-cyan' : 'text-white'" x-text="${valueExpression}"> </span>
      </template>
    </button>
  `;
}

function usageSummaryMetricPair(first: ReturnType<typeof html>, second: ReturnType<typeof html>) {
  return html` <div class="grid grid-cols-2 lg:grid-cols-1 gap-2">${first} ${second}</div> `;
}

function codeBlock(lang: string, ref: string, snippetFn: string, copyId: string) {
  return html`
    <div class="relative group">
      <pre
        class="bg-surface-900 rounded-xl p-4 pr-10 overflow-x-auto border border-white/[0.04]"
      ><code class="language-${lang}" x-ref="${ref}" x-effect="$el.textContent = ${snippetFn}(); Prism.highlightElement($el)"></code></pre>
      <button
        @click="copySnippet(${snippetFn}(), '${copyId}')"
        class="absolute top-2.5 right-2.5 p-1.5 rounded-md bg-surface-700/80 text-gray-500 hover:text-accent-cyan hover:bg-surface-600 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
        aria-label="Copy snippet"
        :title="copied === '${copyId}' ? 'Copied!' : 'Copy'"
      >
        <svg x-show="copied !== '${copyId}'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg x-show="copied === '${copyId}'" class="w-3.5 h-3.5 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  `;
}

function endpointRow(method: 'GET' | 'POST', path: string, name: string, docsHref: string) {
  const methodClass = method === 'GET' ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-accent-emerald/10 text-accent-emerald';

  return html`
    <div class="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-white/[0.04] py-2 last:border-b-0">
      <span class="shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-bold ${methodClass}">${method}</span>
      <code class="min-w-0 max-w-[48%] truncate font-mono text-xs font-semibold text-gray-300 sm:max-w-[220px]">${path}</code>
      <span class="min-w-0 flex-1 truncate text-xs font-medium text-gray-500"> ${name} </span>
      <a href="${docsHref}" target="_blank" rel="noreferrer" class="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-bold text-accent-cyan hover:underline">
        Docs
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 17 17 7" />
          <path d="M7 7h10v10" />
        </svg>
      </a>
    </div>
  `;
}

function renderUpstreamsSettingsCard() {
  return html`
    <div class="glass-card p-5 sm:p-6 animate-in delay-1">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <h3 class="text-white font-semibold mb-1">Upstreams</h3>
          <p class="text-sm text-gray-400">Ordered providers used for model routing and fallback.</p>
        </div>
        <button @click="openNewUpstreamModal()" class="btn-primary !py-2.5 !px-3 text-xs whitespace-nowrap">
          Add Upstream
        </button>
      </div>

      <template x-if="!upstreamsLoaded">
        <div class="space-y-2">
          <div class="h-14 bg-surface-600 rounded animate-pulse"></div>
          <div class="h-14 bg-surface-600 rounded animate-pulse"></div>
        </div>
      </template>

      <template x-if="upstreamsLoaded && upstreams.length === 0">
        <p class="text-sm text-gray-500">No upstreams configured. Add an upstream to serve models.</p>
      </template>

      <template x-if="upstreamsLoaded && upstreams.length > 0">
        <div class="space-y-2">
          <template x-for="up in upstreams" :key="up.id">
            <div class="rounded-lg border border-white/5 bg-surface-800/80 p-3">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0 flex-1">
                  <div class="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
                    <span class="rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide" :class="providerBadgeClass(up.provider)" x-text="providerLabel(up.provider)"></span>
                    <span class="rounded bg-surface-900/70 px-2 py-0.5 text-[11px] font-medium text-gray-400" x-text="upstreamModelSummary(up)"></span>
                  </div>
                  <p class="truncate text-sm font-semibold text-white" x-text="up.name"></p>
                  <p class="truncate text-xs text-gray-500" :title="upstreamSubtitle(up)" x-text="upstreamSubtitle(up)"></p>
                </div>

                <div class="flex shrink-0 items-center justify-end gap-1.5">
                  <label class="relative inline-flex h-7 w-12 cursor-pointer items-center" title="Toggle upstream">
                    <input
                      type="checkbox"
                      class="peer sr-only"
                      :checked="up.enabled"
                      @change="setUpstreamEnabled(up, $event.target.checked)"
                      aria-label="Toggle upstream enabled"
                    />
                    <span class="h-6 w-11 rounded-full bg-surface-600 transition-colors peer-checked:bg-accent-emerald/70"></span>
                    <span class="absolute left-1 h-4 w-4 rounded-full bg-gray-300 transition-transform peer-checked:translate-x-5 peer-checked:bg-white"></span>
                  </label>

                  <button
                    type="button"
                    @click="moveUpstream(up.id, -1)"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                    :disabled="upstreamMoveDisabled(up.id, -1)"
                    aria-label="Move upstream up"
                    title="Move up"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="m18 15-6-6-6 6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    @click="moveUpstream(up.id, 1)"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                    :disabled="upstreamMoveDisabled(up.id, 1)"
                    aria-label="Move upstream down"
                    title="Move down"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    @click="openUpstreamModal(up)"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan"
                    aria-label="Edit upstream"
                    title="Edit"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      <path d="m15 5 4 4" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    @click="deleteUpstream(up.id, up.name)"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
                    aria-label="Delete upstream"
                    title="Delete"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  `;
}

export function renderDashboardHeader() {
  return html`
    <header class="border-b border-white/5 bg-surface-900/80 backdrop-blur-md sticky top-0 z-50">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-surface-700 glow-border flex items-center justify-center">
            <svg class="w-4 h-4 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span class="font-semibold text-white text-sm tracking-tight">Floway</span>
        </div>

        <nav class="order-3 flex w-full max-w-full gap-1 overflow-x-auto rounded-lg bg-surface-800 p-0.5 sm:order-none sm:w-fit">
          <template x-if="isAdmin">
            <button
              @click="switchTab('settings')"
              class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
              :class="tab === 'settings' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              Settings
            </button>
          </template>
          <button
            @click="switchTab('models')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'models' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            Models
          </button>
          <button
            @click="switchTab('keys')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'keys' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            API Keys
          </button>
          <button
            @click="switchTab('usage')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'usage' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            Usage
          </button>
          <button
            @click="switchTab('performance')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'performance' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            Performance
          </button>
        </nav>

        <button @click="logout()" class="btn-ghost text-xs ml-auto shrink-0">Logout</button>
      </div>
    </header>
  `;
}

export function renderKeysTab() {
  return html`
    <div x-show="tab === 'keys'">
      <div class="glass-card p-5 sm:p-6 mb-6 animate-in">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">API Keys</span>
          <div x-show="isAdmin" class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <input type="text" x-model="newKeyName" placeholder="Name" class="!text-xs !py-2.5 !px-3 !w-full sm:!w-32 !rounded-lg" @keydown.enter="createNewKey()" />
            <button @click="createNewKey()" class="btn-primary !text-xs !py-2.5 !px-3 !rounded-lg whitespace-nowrap w-full sm:w-auto" :disabled="!newKeyName.trim() || keyCreating">
              <span x-show="!keyCreating">+ Create</span>
              <span x-show="keyCreating" class="flex items-center gap-1.5"> ${spinner('h-3 w-3')} Creating… </span>
            </button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <template x-if="keys.length === 0 && !keysLoading">
            <p class="text-sm text-gray-500 py-4 text-center">No API keys yet. Create one above.</p>
          </template>
          <template x-if="keysLoading && keys.length === 0">
            <div class="space-y-3 py-2">
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
            </div>
          </template>
          <template x-if="keys.length > 0">
            <table class="w-full min-w-[860px] text-sm">
              <thead>
                <tr class="border-b border-white/5">
                  <th class="text-left py-2 pr-4 pl-7 text-xs font-medium text-gray-500 uppercase tracking-widest">Name</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Key</th>
                  <th x-show="isAdmin" class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Upstreams</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Created</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Last Used</th>
                  <th x-show="isAdmin" class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Actions</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="k in keys" :key="k.id">
                  <tr
                    @click="selectedKeyId = k.id"
                    class="border-b border-white/[0.03] transition-colors cursor-pointer"
                    :class="selectedKeyId === k.id ? 'bg-accent-cyan/5 hover:bg-accent-cyan/8' : 'hover:bg-white/[0.02]'"
                  >
                    <td class="py-3 pr-4 pl-2">
                      <div class="flex items-center gap-2 min-w-0">
                        <div class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors" :class="selectedKeyId === k.id ? 'bg-accent-cyan' : 'bg-transparent'"></div>
                        <span class="text-white font-medium truncate" x-text="k.name"></span>
                      </div>
                    </td>
                    <td class="py-3 pr-4">
                      <code class="text-xs font-mono text-gray-500 bg-surface-800 rounded px-2 py-1" x-text="truncateKey(k.key)"></code>
                    </td>
                    <td x-show="isAdmin" class="py-3 pr-4">
                      <span class="text-xs cursor-default" :class="keyUpstreamsTextClass(k)" :title="keyUpstreamsTitle(k)" x-text="keyUpstreamsText(k)"></span>
                    </td>
                    <td class="py-3 pr-4">
                      <span class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.created_at)" x-text="timeAgo(k.created_at)"></span>
                    </td>
                    <td class="py-3 pr-4">
                      <span x-show="k.last_used_at" class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.last_used_at)" x-text="timeAgo(k.last_used_at)"></span>
                      <span x-show="!k.last_used_at" class="text-gray-600 text-xs">Never</span>
                    </td>
                    <td class="py-3 pr-2 text-right">
                      <div class="flex items-center justify-end gap-1">
                        <button
                          @click.stop="copySnippet(k.key, 'key-' + k.id)"
                          class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1"
                          aria-label="Copy API key"
                          title="Copy key"
                        >
                          <svg x-show="copied !== 'key-' + k.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          <svg x-show="copied === 'key-' + k.id" class="w-4 h-4 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="openEditKey(k)"
                            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1"
                            aria-label="Edit API key"
                            title="Edit key"
                          >
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                        </template>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="rotateKeyById(k.id, k.name)"
                            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-amber hover:bg-white/[0.04] transition-colors p-1"
                            aria-label="Rotate API key"
                            :disabled="keyRotating === k.id"
                            title="Rotate key"
                          >
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M21.5 2v6h-6" />
                              <path d="M2.5 22v-6h6" />
                              <path d="M2.5 12a10 10 0 0 1 16.5-5.7L21.5 8" />
                              <path d="M21.5 12a10 10 0 0 1-16.5 5.7L2.5 16" />
                            </svg>
                          </button>
                        </template>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="deleteKeyById(k.id, k.name)"
                            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-rose hover:bg-white/[0.04] transition-colors p-1"
                            aria-label="Delete API key"
                            :disabled="keyDeleting === k.id"
                            title="Delete key"
                          >
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </template>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </template>
        </div>
      </div>

      <div class="glass-card p-5 sm:p-6 animate-in delay-1">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Configuration</span>
        <template x-if="selectedKeyId">
          <p class="text-xs text-accent-cyan mt-2 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            Configs below use the selected key.
          </p>
        </template>

        <template x-if="!modelsLoaded">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
            <div class="space-y-3">
              <div class="h-5 w-28 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-7 w-40 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-32 bg-surface-600 rounded-xl animate-pulse"></div>
            </div>
            <div class="space-y-3">
              <div class="h-5 w-20 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-7 w-40 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-32 bg-surface-600 rounded-xl animate-pulse"></div>
            </div>
          </div>
        </template>

        <template x-if="modelsLoaded">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
            <div>
              <div class="mb-3">
                <span class="text-sm font-semibold text-white">Claude Code</span>
              </div>

              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex min-w-0 items-center gap-2">
                  <label class="text-xs text-gray-500">Model:</label>
                  <select
                    x-model="claudeModel"
                    class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsBig" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
                <div class="flex min-w-0 items-center gap-2">
                  <label class="text-xs text-gray-500">Sonnet:</label>
                  <select
                    x-model="claudeSonnetModel"
                    class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsSonnet" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
                <div class="flex min-w-0 items-center gap-2">
                  <label class="text-xs text-gray-500">Haiku:</label>
                  <select
                    x-model="claudeSmallModel"
                    class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsSmall" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>

              <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
              ${codeBlock('bash', 'claudeCode', 'claudeCodeSnippet', 'claude')}
            </div>

            <div>
              <div class="mb-3">
                <span class="text-sm font-semibold text-white">Codex</span>
              </div>

              <div class="flex min-w-0 items-center gap-2 mb-3">
                <label class="text-xs text-gray-500">Model:</label>
                <select
                  x-model="codexModel"
                  class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                >
                  <template x-for="m in codexModels" :key="m">
                    <option :value="m" x-text="m"></option>
                  </template>
                </select>
              </div>

              <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.codex/config.toml</code></p>
              ${codeBlock('toml', 'codexCode', 'codexSnippet', 'codex')}

              <p class="text-[11px] text-gray-600 mt-4 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
              ${codeBlock('bash', 'codexEnv', 'codexEnvSnippet', 'codexEnv')}
            </div>
          </div>
        </template>
      </div>

      <template x-if="editKeyModal.open">
        <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in overflow-y-auto">
          <div @click.self="closeEditKey()" class="flex min-h-full items-start justify-center p-3 sm:p-5">
            <div class="glass-card glow-cyan my-auto w-full max-w-xl overflow-hidden">
              <div class="border-b border-white/[0.06] px-4 py-3 sm:px-5">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="truncate text-base font-semibold text-white">Edit API Key</h3>
                  <button
                    @click="closeEditKey()"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-white/[0.04] hover:text-white"
                    aria-label="Close edit key editor"
                    title="Close"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>

              <div class="max-h-[calc(100dvh-9rem)] overflow-y-auto px-4 py-4 sm:px-5">
                <div class="flex flex-col gap-5">
                  <div>
                    <label class="mb-1.5 block text-xs font-medium text-gray-500">Name</label>
                    <input type="text" class="!py-2.5 !px-3 !text-xs" x-model="editKeyModal.name" aria-label="API key name" />
                  </div>

                  <div>
                    <div class="mb-2 flex items-center justify-between gap-3">
                      <p class="text-xs font-semibold text-gray-400">
                        <span>Override Available Upstreams</span>
                        <span x-show="editKeyModal.override && editKeyIncludedCount() > 0"
                          class="ml-1.5 font-mono text-[10px] font-medium text-accent-cyan"
                          x-text="'(' + editKeyIncludedCount() + ')'"></span>
                      </p>
                      <div class="flex items-center gap-3">
                        <span x-show="editKeyModal.override" x-cloak class="flex items-center gap-2 text-[11px] text-gray-500">
                          <button type="button" @click="editKeySelectAll()" class="hover:text-accent-cyan">Select all</button>
                          <span class="text-gray-700">·</span>
                          <button type="button" @click="editKeySelectNone()" class="hover:text-accent-cyan">Clear</button>
                        </span>
                        <button type="button"
                          @click="toggleEditKeyOverride()"
                          class="inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
                          :class="editKeyModal.override ? 'bg-accent-cyan' : 'bg-white/10'"
                          :aria-pressed="editKeyModal.override.toString()"
                          aria-label="Toggle custom upstream override">
                          <span class="h-4 w-4 transform rounded-full bg-white transition-transform"
                            :class="editKeyModal.override ? 'translate-x-4' : 'translate-x-0.5'"></span>
                        </button>
                      </div>
                    </div>

                    <p x-show="!editKeyModal.override" class="text-[11px] leading-relaxed text-gray-500">
                      Currently inherits the global upstream order (total <span class="text-gray-400" x-text="editKeyModal.allUpstreams.length"></span> upstreams). Turn on to specify a custom list and order.
                    </p>

                    <div x-show="editKeyModal.override" x-cloak>
                      <ul x-ref="editKeyList" class="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border border-white/10 bg-surface-800/40 p-2">
                        <template x-for="row in editKeyModal.customOrder" :key="row.id">
                          <li class="flex items-center gap-2 rounded-md border border-white/5 bg-surface-900/40 px-2 py-2 transition-opacity"
                            :class="row.included ? '' : 'opacity-50'"
                            :data-id="row.id">
                            <span class="drag-handle inline-flex h-7 w-5 items-center justify-center text-gray-500 hover:text-gray-300" aria-hidden="true">
                              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="9" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" />
                                <circle cx="15" cy="6" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                              </svg>
                            </span>
                            <label class="flex flex-1 cursor-pointer items-center gap-2">
                              <input type="checkbox" class="accent-accent-cyan" :checked="row.included" @change="toggleEditKeyRow(row.id)" />
                              <span class="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                                :class="providerBadgeClass(row.provider)" x-text="providerLabel(row.provider)"></span>
                              <span class="truncate text-xs text-white" x-text="row.name"></span>
                            </label>
                            <span class="font-mono text-[10px] text-gray-600"
                              x-text="row.included ? (editKeyOrderPosition(row.id) + '/' + editKeyIncludedCount()) : ''"></span>
                          </li>
                        </template>
                      </ul>
                      <p class="mt-2 text-[11px] leading-relaxed text-gray-500">
                        New upstreams added in the future will <span class="font-semibold text-gray-400">NOT</span> be included automatically.
                      </p>
                    </div>
                  </div>

                  <template x-if="editKeyModal.error">
                    <p class="break-words rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-300" x-text="editKeyModal.error"></p>
                  </template>
                </div>
              </div>

              <div class="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-surface-900/40 px-4 py-3 sm:px-5">
                <button @click="closeEditKey()" class="btn-ghost !rounded-lg !px-4 !py-2 !text-xs">Cancel</button>
                <button @click="saveEditKey()" :disabled="!canSaveEditKey() || editKeyModal.saving"
                  class="btn-primary !rounded-lg !px-4 !py-2 !text-xs">
                  <span x-show="!editKeyModal.saving">Save changes</span>
                  <span x-show="editKeyModal.saving" class="flex items-center gap-1.5">${spinner('h-3 w-3')} Saving…</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  `;
}

export function renderUsageTab() {
  return html`
    <div x-show="tab === 'usage'">
      <div class="glass-card p-6 animate-in">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Token Usage — By Key</span>
            <button
              @click="toggleRedactKeys()"
              class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md p-1 transition-colors text-gray-600 hover:text-gray-400 hover:bg-white/[0.04]"
              aria-label="Toggle key name redaction"
              title="Redact key names"
            >
              <svg x-show="!redactKeys" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg x-show="redactKeys" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            </button>
            <template x-if="tokenLoading"> ${spinner('h-3.5 w-3.5 text-gray-500')} </template>
          </div>
          <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
            <button
              @click="switchTokenRange('today')"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              Last Day
            </button>
            <button
              @click="switchTokenRange('7d')"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              7 Days
            </button>
            <button
              @click="switchTokenRange('30d')"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              30 Days
            </button>
          </div>
        </div>

        <div style="height: 320px; position: relative;">
          <template x-if="tokenLoading && !chartsReady">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                ${spinner('h-6 w-6 text-accent-cyan/60')}
                <span class="text-xs text-gray-500">Loading usage data…</span>
              </div>
            </div>
          </template>
          <canvas id="tokenChartByKey"></canvas>
        </div>

        <div class="mt-6 pt-5 border-t border-white/5">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4 block">By Model</span>
          <div style="height: 320px; position: relative;">
            <template x-if="tokenLoading && !chartsReady">
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex flex-col items-center gap-3">
                  ${spinner('h-6 w-6 text-accent-cyan/60')}
                  <span class="text-xs text-gray-500">Loading usage data…</span>
                </div>
              </div>
            </template>
            <canvas id="tokenChartByModel"></canvas>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-6 pt-5 border-t border-white/5">
          ${usageSummaryMetricPair(
            usageSummaryMetric('requests', 'Requests', 'tokenSummary.requests.toLocaleString()', 'w-16'),
            usageSummaryMetric(
              'cost',
              'Est. Cost',
              "tokenSummary.cost >= 1 ? '$' + tokenSummary.cost.toFixed(2) : tokenSummary.cost >= 0.01 ? '$' + tokenSummary.cost.toFixed(3) : tokenSummary.cost > 0 ? '$' + tokenSummary.cost.toFixed(4) : '$0'",
              'w-20',
            ),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('total', 'Total Tokens', 'tokenSummary.total.toLocaleString()', 'w-20'),
            usageSummaryMetric('output', 'Output Tokens', 'tokenSummary.output.toLocaleString()', 'w-20'),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('input', 'Input Tokens', 'tokenSummary.input.toLocaleString()', 'w-20'),
            usageSummaryMetric('prefill', 'Prefill Input', 'tokenSummary.prefill.toLocaleString()', 'w-20'),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('cached', 'Cached Input', 'tokenSummary.cacheRead.toLocaleString()', 'w-20'),
            usageSummaryMetric('cachedRate', 'Cached Rate', 'formatInputRate(tokenSummary.cacheRead, tokenSummary.input)', 'w-20'),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('cacheCreation', 'Cache Write', 'tokenSummary.cacheCreation.toLocaleString()', 'w-20'),
            usageSummaryMetric('cacheHitRate', 'Cache Hit Rate', 'formatHitRate(tokenSummary.cacheRead, tokenSummary.cacheCreation)', 'w-20'),
          )}
        </div>

        <div x-show="searchUsageActiveProvider !== 'disabled'" class="mt-6 pt-5 border-t border-white/5">
          <div class="flex items-center gap-3 mb-4">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest block">Search Usage — Per Key</span>
            <template x-if="searchUsageLoading"> ${spinner('h-3.5 w-3.5 text-gray-500')} </template>
          </div>
          <div style="height: 320px; position: relative;">
            <template x-if="searchUsageLoading && !chartsReady">
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex flex-col items-center gap-3">
                  ${spinner('h-6 w-6 text-accent-cyan/60')}
                  <span class="text-xs text-gray-500">Loading usage data…</span>
                </div>
              </div>
            </template>
            <canvas id="searchUsageChartByKey"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderPerformanceTab() {
  return html`
    <div x-show="tab === 'performance'">
      <div class="glass-card p-6 animate-in">
        <div class="flex flex-col gap-4 mb-6 lg:flex-row lg:items-center lg:justify-between">
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Performance</span>
            <template x-if="performanceLoading"> ${spinner('h-3.5 w-3.5 text-gray-500')} </template>
          </div>
          <div class="flex max-w-full flex-wrap items-center gap-2">
            <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformanceMetricScope('request_total')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceMetricScope === 'request_total' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                Total
              </button>
              <button
                @click="switchPerformanceMetricScope('upstream_success')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceMetricScope === 'upstream_success' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                Upstream
              </button>
            </div>
            <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformanceChartView('model')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceChartView === 'model' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                By Model
              </button>
              <button
                @click="switchPerformanceChartView('percentile')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceChartView === 'percentile' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                By Percentile
              </button>
            </div>
            <div x-show="performanceChartView === 'model'" class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformancePercentile('p50Ms')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performancePercentile === 'p50Ms' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                p50
              </button>
              <button
                @click="switchPerformancePercentile('p95Ms')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performancePercentile === 'p95Ms' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                p95
              </button>
              <button
                @click="switchPerformancePercentile('p99Ms')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performancePercentile === 'p99Ms' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                p99
              </button>
            </div>
            <div x-show="performanceChartView === 'percentile'" class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <select
                x-model="performanceModel"
                @change="renderPerformanceChart()"
                class="shrink-0 min-w-44 max-w-64 rounded-md bg-surface-600 px-3 py-1.5 text-xs font-medium text-white outline-none"
                aria-label="Performance model"
              >
                <template x-for="model in performanceModelOptions()" :key="model">
                  <option :value="model" x-text="model"></option>
                </template>
              </select>
            </div>
            <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformanceRange('today')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                Last Day
              </button>
              <button
                @click="switchPerformanceRange('7d')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                7 Days
              </button>
              <button
                @click="switchPerformanceRange('30d')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                30 Days
              </button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 mb-6 lg:grid-cols-6">
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">Successful</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="performanceSummary.requests.toLocaleString()"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">Errors</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="performanceSummary.errors.toLocaleString()"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">Average</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.avgMs)"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">p50</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.p50Ms)"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">p95</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.p95Ms)"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">p99</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.p99Ms)"></span>
          </div>
        </div>

        <div style="height: 340px; position: relative;">
          <template x-if="performanceLoading && !chartsReady">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                ${spinner('h-6 w-6 text-accent-cyan/60')}
                <span class="text-xs text-gray-500">Loading performance data…</span>
              </div>
            </div>
          </template>
          <canvas id="performanceChartByModel"></canvas>
        </div>

        <div class="grid grid-cols-1 gap-5 mt-6 pt-5 border-t border-white/5 lg:grid-cols-2">
          <div>
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3 block">By Model</span>
            <div class="overflow-x-auto rounded-md border border-white/5">
              <table class="w-full text-sm">
                <thead class="bg-surface-800/70 text-xs uppercase tracking-widest text-gray-500">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">Model</th>
                    <th class="px-3 py-2 text-right font-medium">Req</th>
                    <th class="px-3 py-2 text-right font-medium" x-text="performancePercentileLabel()"></th>
                    <th class="px-3 py-2 text-right font-medium">Avg</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-white/5">
                  <template x-for="row in performanceModelRows" :key="row.group">
                    <tr>
                      <td class="px-3 py-2 text-gray-300" x-text="row.group"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="row.requests.toLocaleString()"></td>
                      <td class="px-3 py-2 text-right font-mono text-white" x-text="formatDuration(row[performancePercentile])"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="formatDuration(row.avgMs)"></td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
          <div x-show="performanceRuntimeRows.length > 0">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3 block">By Region</span>
            <div class="overflow-x-auto rounded-md border border-white/5">
              <table class="w-full text-sm">
                <thead class="bg-surface-800/70 text-xs uppercase tracking-widest text-gray-500">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">Region</th>
                    <th class="px-3 py-2 text-right font-medium">Req</th>
                    <th class="px-3 py-2 text-right font-medium" x-text="performancePercentileLabel()"></th>
                    <th class="px-3 py-2 text-right font-medium">Avg</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-white/5">
                  <template x-for="row in performanceRuntimeRows" :key="row.group">
                    <tr>
                      <td class="px-3 py-2 text-gray-300" x-text="row.group"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="row.requests.toLocaleString()"></td>
                      <td class="px-3 py-2 text-right font-mono text-white" x-text="formatDuration(row[performancePercentile])"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="formatDuration(row.avgMs)"></td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderSettingsTab() {
  return html`
    <template x-if="isAdmin">
      <div x-show="tab === 'settings'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
        <template x-if="deviceFlow.userCode">
          <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in overflow-y-auto p-4">
            <div class="glass-card p-6 sm:p-8 max-w-md w-full glow-cyan">
              <h3 class="text-white text-lg font-semibold mb-2">GitHub Authorization</h3>
              <p class="text-gray-400 text-sm mb-6">Enter this code on GitHub to authorize:</p>

              <div class="bg-surface-900 rounded-xl p-6 text-center mb-6 glow-border">
                <code class="block text-2xl sm:text-3xl font-mono font-bold text-accent-cyan tracking-[0.2em] sm:tracking-[0.3em] break-all" x-text="deviceFlow.userCode"></code>
              </div>

              <p class="text-gray-500 text-xs text-center mb-2">
                Visit <a :href="deviceFlow.verificationUri" class="text-accent-cyan hover:underline break-all" x-text="deviceFlow.verificationUri" target="_blank"></a>
              </p>
              <a :href="deviceFlow.verificationUri" target="_blank" class="btn-primary w-full block text-center mb-4"> Open GitHub </a>

              <div class="flex items-center justify-center gap-2 text-sm text-gray-500">${spinner('h-4 w-4')} Waiting for authorization…</div>

              <button @click="cancelDeviceFlow()" class="btn-ghost w-full mt-4">Cancel</button>
            </div>
          </div>
        </template>

        <template x-if="upstreamModal.open">
          <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in overflow-y-auto">
            <div @click.self="closeUpstreamModal()" class="flex min-h-full items-start justify-center p-3 sm:p-5">
              <div class="glass-card w-full max-w-4xl glow-cyan my-auto overflow-hidden">
                <div class="border-b border-white/[0.06] px-4 py-3 sm:px-5">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-3">
                      <span class="shrink-0 rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide" :class="providerBadgeClass(upstreamModal.provider)" x-text="providerLabel(upstreamModal.provider)"></span>
                      <h3 class="truncate text-base font-semibold text-white" x-text="upstreamModal.name || (upstreamModal.id ? 'Edit Upstream' : 'Add Upstream')"></h3>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <label class="relative inline-flex h-9 w-12 cursor-pointer items-center justify-center" title="Toggle upstream">
                        <input type="checkbox" class="peer sr-only" x-model="upstreamModal.enabled" aria-label="Toggle upstream enabled in editor" />
                        <span class="h-6 w-11 rounded-full bg-surface-600 transition-colors peer-checked:bg-accent-emerald/70"></span>
                        <span class="absolute left-1.5 h-4 w-4 rounded-full bg-gray-300 transition-transform peer-checked:translate-x-5 peer-checked:bg-white"></span>
                      </label>
                      <button @click="closeUpstreamModal()" class="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-white/[0.04] hover:text-white" aria-label="Close upstream editor" title="Close">
                        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                <div class="max-h-[calc(100dvh-9rem)] overflow-y-auto px-4 py-4 sm:px-5">
                  <div class="flex flex-col gap-4">
                    <template x-if="!upstreamModal.id">
                      <div>
                        <p class="mb-2 text-xs font-medium text-gray-500">Provider</p>
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <button type="button" @click="setUpstreamModalProvider('custom')" class="rounded-lg border p-3 text-left transition-colors" :class="upstreamModal.provider === 'custom' ? 'border-accent-amber/40 bg-accent-amber/5' : 'border-white/10 bg-surface-800/40 hover:border-white/20'">
                            <span class="block text-sm font-semibold text-white">Custom</span>
                            <span class="mt-1 block text-xs text-gray-500">OpenAI-compatible bearer provider</span>
                          </button>
                          <button type="button" @click="setUpstreamModalProvider('azure')" class="rounded-lg border p-3 text-left transition-colors" :class="upstreamModal.provider === 'azure' ? 'border-accent-emerald/40 bg-accent-emerald/5' : 'border-white/10 bg-surface-800/40 hover:border-white/20'">
                            <span class="block text-sm font-semibold text-white">Azure</span>
                            <span class="mt-1 block text-xs text-gray-500">Azure OpenAI and Foundry deployments</span>
                          </button>
                          <button type="button" @click="setUpstreamModalProvider('copilot')" class="rounded-lg border p-3 text-left transition-colors" :class="upstreamModal.provider === 'copilot' ? 'border-accent-cyan/40 bg-accent-cyan/5' : 'border-white/10 bg-surface-800/40 hover:border-white/20'">
                            <span class="block text-sm font-semibold text-white">Copilot</span>
                            <span class="mt-1 block text-xs text-gray-500">Connect a GitHub Copilot account</span>
                          </button>
                        </div>
                      </div>
                    </template>

                    <div>
                      <label class="mb-1.5 block text-xs font-medium text-gray-500">Name</label>
                      <input type="text" class="!py-2.5 !px-3 !text-xs" placeholder="e.g. OpenAI Production" x-model="upstreamModal.name" aria-label="Upstream name" />
                    </div>

                    <template x-if="upstreamModal.provider === 'custom'">
                      <div class="flex flex-col gap-4">
                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <label class="mb-1.5 block text-xs font-medium text-gray-500">Base URL</label>
                            <input type="text" class="!py-2.5 !px-3 !text-xs font-mono" placeholder="e.g. https://api.openai.com" x-model="upstreamModal.baseUrl" />
                          </div>
                          <div>
                            <label class="mb-1.5 block text-xs font-medium text-gray-500">
                              <span x-text="upstreamModal.id ? (upstreamModal.authStyle === 'anthropic' ? 'API Key (leave blank to keep)' : 'Bearer Token (leave blank to keep)') : (upstreamModal.authStyle === 'anthropic' ? 'API Key' : 'Bearer Token')"></span>
                            </label>
                            <input type="password" autocomplete="off" class="!py-2.5 !px-3 !text-xs font-mono" :placeholder="upstreamModal.authStyle === 'anthropic' ? 'sk-ant-xxxxx' : 'sk-xxxxx'" x-model="upstreamModal.bearerToken" />
                          </div>
                        </div>

                        <div>
                          <p class="mb-2 text-xs font-medium text-gray-500">Auth Style</p>
                          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <label class="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 transition-colors hover:border-white/20" :class="upstreamModal.authStyle === 'bearer' ? 'border-accent-cyan/40 bg-accent-cyan/5' : ''">
                              <input type="radio" name="customAuthStyle" value="bearer" class="mt-0.5 accent-accent-cyan" :checked="upstreamModal.authStyle === 'bearer'" @change="upstreamModal.authStyle = 'bearer'" />
                              <span class="flex flex-col gap-0.5">
                                <span class="font-medium">Bearer</span>
                                <span class="font-mono text-[10px] text-gray-600">Authorization: Bearer &lt;token&gt;</span>
                              </span>
                            </label>
                            <label class="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 transition-colors hover:border-white/20" :class="upstreamModal.authStyle === 'anthropic' ? 'border-accent-cyan/40 bg-accent-cyan/5' : ''">
                              <input type="radio" name="customAuthStyle" value="anthropic" class="mt-0.5 accent-accent-cyan" :checked="upstreamModal.authStyle === 'anthropic'" @change="upstreamModal.authStyle = 'anthropic'" />
                              <span class="flex flex-col gap-0.5">
                                <span class="font-medium">Anthropic</span>
                                <span class="font-mono text-[10px] text-gray-600">x-api-key + anthropic-version</span>
                              </span>
                            </label>
                          </div>
                        </div>

                        <div>
                          <p class="mb-2 text-xs font-medium text-gray-500">Supported Endpoints</p>
                          <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <template x-for="ep in endpointList()" :key="ep">
                              <label class="flex items-center gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300">
                                <input type="checkbox" class="accent-accent-cyan" :checked="upstreamModal.supportedEndpoints.includes(ep)" @change="toggleUpstreamEndpoint(ep)" />
                                <span class="font-mono text-[11px]" x-text="endpointLabel(ep)"></span>
                              </label>
                            </template>
                          </div>
                        </div>

                        <div>
                          <button
                            type="button"
                            @click="upstreamModal.pathOverridesOpen = !upstreamModal.pathOverridesOpen"
                            :aria-expanded="upstreamModal.pathOverridesOpen.toString()"
                            class="mb-2 flex w-full items-center justify-between text-left text-xs font-medium text-gray-500 transition-colors hover:text-gray-300"
                          >
                            <span class="flex items-center gap-1.5">
                              <span>Path Overrides</span>
                              <span x-show="upstreamModalOverrideCount() > 0" class="font-mono text-[10px] text-accent-cyan" x-text="'(+' + upstreamModalOverrideCount() + ')' "></span>
                            </span>
                            <span class="flex items-center gap-2 normal-case tracking-normal text-[10px] text-gray-600">
                              <svg class="h-3 w-3 transition-transform" :class="upstreamModal.pathOverridesOpen ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            </span>
                          </button>
                          <div x-show="upstreamModal.pathOverridesOpen" x-cloak>
                            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <template x-for="key in ['chat_completions','responses','messages','embeddings','models']" :key="key">
                                <label class="min-w-0">
                                  <span class="mb-1 block truncate font-mono text-[10px] text-gray-500" x-text="key"></span>
                                  <input type="text" class="!py-2 !px-2.5 !text-[11px] font-mono" :placeholder="'/v1/' + key.replace('_', '/')" x-model="upstreamModal.pathOverrides[key]" />
                                </label>
                              </template>
                            </div>
                            <p class="mt-3 text-xs text-gray-400">
                              Leave blank to use the OpenAI default <code class="font-mono">/v1/&lt;endpoint&gt;</code>. Count tokens follows the messages path.
                            </p>
                          </div>
                        </div>
                      </div>
                    </template>

                    <template x-if="upstreamModal.provider === 'azure'">
                      <div class="flex flex-col gap-4">
                        <div class="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                          <div>
                            <label class="mb-1.5 block text-xs font-medium text-gray-500">Endpoint</label>
                            <input
                              type="text"
                              class="!py-2.5 !px-3 !text-xs font-mono"
                              placeholder="e.g. https://resource.openai.azure.com/openai/v1"
                              x-model="upstreamModal.endpoint"
                              aria-label="Azure endpoint"
                            />
                          </div>
                          <div>
                            <label class="mb-1.5 block text-xs font-medium text-gray-500">
                              <span x-text="upstreamModal.id ? 'API Key (leave blank to keep)' : 'API Key'"></span>
                            </label>
                            <input
                              type="password"
                              autocomplete="off"
                              class="!py-2.5 !px-3 !text-xs font-mono"
                              placeholder="xxxxx"
                              x-model="upstreamModal.apiKey"
                              aria-label="Azure API key"
                            />
                          </div>
                        </div>

                        <div>
                          <div class="mb-2 flex items-center justify-between gap-3">
                            <p class="text-xs font-medium text-gray-500">Deployments</p>
                            <div x-show="!upstreamModal.deploymentsJsonMode" class="flex items-center gap-2">
                              <button type="button" @click="addAzureDeployment()" class="btn-ghost !py-1.5 !px-2.5 text-xs">Add Deployment</button>
                              <button type="button" @click="setAzureDeploymentsJsonMode(true)" class="btn-ghost !py-1.5 !px-2.5 text-xs">Edit as JSON</button>
                            </div>
                            <button x-show="upstreamModal.deploymentsJsonMode" x-cloak type="button" @click="setAzureDeploymentsJsonMode(false)" class="btn-ghost !py-1.5 !px-2.5 text-xs">Edit with UI</button>
                          </div>
                          <div x-show="!upstreamModal.deploymentsJsonMode" class="flex flex-col gap-2">
                            <template x-for="(deployment, index) in upstreamModal.deployments" :key="index">
                              <div class="overflow-hidden rounded-lg border border-white/10 bg-surface-800/35">
                                <div class="flex items-center gap-1">
                                  <button type="button" @click="toggleAzureDeployment(index)" class="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-white/[0.03]" :aria-expanded="deployment.open.toString()">
                                    <span class="min-w-0 truncate text-sm font-semibold text-white" x-text="azureDeploymentTitle(deployment)"></span>
                                    <svg class="h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform" :class="deployment.open ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                      <polyline points="6 9 12 15 18 9" />
                                    </svg>
                                  </button>
                                  <button type="button" @click="removeAzureDeployment(index)" class="mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-600 hover:bg-white/[0.04] hover:text-accent-rose" aria-label="Remove deployment" title="Remove deployment">
                                    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                      <line x1="18" y1="6" x2="6" y2="18" />
                                      <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                  </button>
                                </div>

                                <div x-show="deployment.open" x-cloak class="border-t border-white/[0.06] p-3">
                                  <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                                    <label class="min-w-0">
                                      <span class="mb-1.5 block text-xs font-medium text-gray-500">Display Name</span>
                                      <input type="text" class="!py-2 !px-2.5 !text-xs" placeholder="e.g. GPT 5.4 Pro" x-model="deployment.display_name" aria-label="Azure deployment display name" />
                                    </label>
                                    <label class="min-w-0">
                                      <span class="mb-1.5 block text-xs font-medium text-gray-500">Deployment</span>
                                      <input type="text" class="!py-2 !px-2.5 !text-xs font-mono" placeholder="e.g. gpt-5.4-pro" x-model="deployment.deployment" aria-label="Azure deployment name" />
                                    </label>
                                    <label class="min-w-0">
                                      <span class="mb-1.5 block text-xs font-medium text-gray-500">Public Model ID</span>
                                      <input type="text" class="!py-2 !px-2.5 !text-xs font-mono" :placeholder="deployment.deployment" x-model="deployment.publicModelId" aria-label="Azure public model id" />
                                    </label>
                                    <label class="min-w-0">
                                      <span class="mb-1.5 block text-xs font-medium text-gray-500">API Type</span>
                                      <select x-model="deployment.apiType" class="!py-2 !px-2.5 !text-xs font-mono" aria-label="Azure deployment API type">
                                        <template x-for="type in azureDeploymentApiTypes()" :key="type">
                                          <option :value="type" x-text="azureDeploymentApiTypeLabel(type)"></option>
                                        </template>
                                      </select>
                                    </label>
                                  </div>

                                  <div class="mt-4">
                                    <p class="mb-2 text-xs font-semibold text-gray-400">Context Limits</p>
                                    <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                                      <label class="min-w-0">
                                        <span class="mb-1 block text-[11px] font-medium text-gray-500">Context Window</span>
                                        <input type="number" class="!py-2 !px-2.5 !text-[11px] font-mono" placeholder="e.g. 1050000" x-model="deployment.limits.max_context_window_tokens" />
                                      </label>
                                      <label class="min-w-0">
                                        <span class="mb-1 block text-[11px] font-medium text-gray-500">Prompt Tokens</span>
                                        <input type="number" class="!py-2 !px-2.5 !text-[11px] font-mono" placeholder="e.g. 922000" x-model="deployment.limits.max_prompt_tokens" />
                                      </label>
                                      <label class="min-w-0">
                                        <span class="mb-1 block text-[11px] font-medium text-gray-500">Output Tokens</span>
                                        <input type="number" class="!py-2 !px-2.5 !text-[11px] font-mono" placeholder="e.g. 128000" x-model="deployment.limits.max_output_tokens" />
                                      </label>
                                    </div>
                                  </div>

                                  <div class="mt-4">
                                    <p class="mb-2 text-xs font-semibold text-gray-400">Pricing</p>
                                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                                      <label class="min-w-0">
                                        <span class="mb-1 block text-[11px] font-medium text-gray-500">Input ($/MTok)</span>
                                        <input type="number" step="any" min="0" class="!py-2 !px-2.5 !text-[11px] font-mono" placeholder="e.g. 2.5" x-model="deployment.cost.input" />
                                      </label>
                                      <label class="min-w-0">
                                        <span class="mb-1 block text-[11px] font-medium text-gray-500">Output ($/MTok)</span>
                                        <input type="number" step="any" min="0" class="!py-2 !px-2.5 !text-[11px] font-mono" placeholder="e.g. 15" x-model="deployment.cost.output" />
                                      </label>
                                      <label class="min-w-0">
                                        <span class="mb-1 block text-[11px] font-medium text-gray-500">Cache Read ($/MTok)</span>
                                        <input type="number" step="any" min="0" class="!py-2 !px-2.5 !text-[11px] font-mono" placeholder="e.g. 0.25" x-model="deployment.cost.cache_read" />
                                      </label>
                                      <label class="min-w-0">
                                        <span class="mb-1 block text-[11px] font-medium text-gray-500">Cache Write ($/MTok)</span>
                                        <input type="number" step="any" min="0" class="!py-2 !px-2.5 !text-[11px] font-mono" placeholder="leave blank if not charged" x-model="deployment.cost.cache_write" />
                                      </label>
                                    </div>
                                    <p class="mt-2 text-[11px] leading-relaxed text-gray-500">
                                      Per-million-token USD rates. Leave all four blank to omit pricing. <span class="text-gray-400">Input</span> and <span class="text-gray-400">Output</span> must both be filled or both blank; <span class="text-gray-400">Cache Read</span> / <span class="text-gray-400">Cache Write</span> are independently optional.
                                    </p>
                                  </div>

                                  <div class="mt-4">
                                    <div class="mb-2 flex items-center justify-between">
                                      <p class="text-xs font-semibold text-gray-400">
                                        <span>Override Feature Flags</span>
                                        <span x-show="deployment.flagOverridesEnabled && Object.keys(deployment.flagOverridesValues ?? {}).length > 0"
                                          class="ml-1.5 font-mono text-[10px] font-medium text-accent-cyan"
                                          x-text="'(+' + Object.keys(deployment.flagOverridesValues).length + ')'"></span>
                                      </p>
                                      <button type="button"
                                        @click="toggleDeploymentFlagOverridesEnabled(deployment)"
                                        class="inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
                                        :class="deployment.flagOverridesEnabled ? 'bg-accent-cyan' : 'bg-white/10'"
                                        :aria-pressed="deployment.flagOverridesEnabled.toString()">
                                        <span class="h-4 w-4 transform rounded-full bg-white transition-transform" :class="deployment.flagOverridesEnabled ? 'translate-x-4' : 'translate-x-0.5'"></span>
                                      </button>
                                    </div>
                                    <div x-show="deployment.flagOverridesEnabled" x-cloak>
                                      <p x-show="upstreamFlagCatalog.length === 0" class="text-[11px] text-gray-600">No flags are registered.</p>
                                      <div x-show="upstreamFlagCatalog.length > 0" class="max-h-72 overflow-y-auto divide-y divide-white/[0.06]">
                                        <template x-for="flag in upstreamFlagCatalog" :key="flag.id">
                                          <div class="flex items-start justify-between gap-3 py-2.5 first:pt-0">
                                            <div class="min-w-0">
                                              <span class="block break-all font-mono text-xs text-white" x-text="flag.label || flag.id"></span>
                                              <span x-show="flag.description" class="mt-0.5 block text-[11px] text-gray-500" x-text="flag.description"></span>
                                            </div>
                                            <div class="flex shrink-0 items-center gap-1 text-[11px]">
                                              <template x-for="state in ['inherit', 'on', 'off']" :key="state">
                                                <label class="flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5"
                                                  :class="flagPillClass(state, deploymentFlagState(deployment, flag.id) === state, upstreamFlagEffective(flag.id))">
                                                  <input type="radio" class="hidden" :name="'depflag-' + index + '-' + flag.id" :value="state" :checked="deploymentFlagState(deployment, flag.id) === state" @change="setDeploymentFlagState(deployment, flag.id, state)" />
                                                  <span x-text="state === 'inherit' ? 'Inherit: ' + upstreamFlagEffective(flag.id) : state === 'on' ? 'On' : 'Off'"></span>
                                                </label>
                                              </template>
                                            </div>
                                          </div>
                                        </template>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </template>
                          </div>
                          <div x-show="upstreamModal.deploymentsJsonMode" x-cloak class="rounded-lg border border-white/10 bg-surface-900/70">
                            <div class="relative h-72 overflow-hidden rounded-lg">
                              <pre x-ref="azureDeploymentsJsonHighlight" aria-hidden="true" class="absolute inset-0 m-0 overflow-auto whitespace-pre p-3 text-[11px] font-mono"><code class="language-json" x-html="azureDeploymentsJsonHighlighted()"></code></pre>
                              <textarea
                                spellcheck="false"
                                wrap="off"
                                x-model="upstreamModal.deploymentsJson"
                                @input="upstreamModal.deploymentsJsonError = null"
                                @scroll="syncAzureDeploymentsJsonScroll($event)"
                                class="absolute inset-0 !m-0 !h-full !resize-none !overflow-auto !rounded-lg !border-0 !bg-transparent !p-3 !text-[11px] font-mono text-transparent caret-gray-100 outline-none selection:bg-accent-cyan/25 focus:!shadow-none focus:!border-0"
                                style="color: transparent; -webkit-text-fill-color: transparent; caret-color: #e0e0e0; line-height: 1.6;"
                                aria-label="Azure deployments JSON"
                              ></textarea>
                            </div>
                            <p x-show="upstreamModal.deploymentsJsonError" x-cloak class="border-t border-accent-rose/20 px-3 py-2 text-xs text-accent-rose" x-text="upstreamModal.deploymentsJsonError"></p>
                          </div>
                        </div>
                      </div>
                    </template>

                    <template x-if="upstreamModal.provider === 'copilot'">
                      <div class="flex flex-col gap-3">
                        <template x-if="!upstreamModal.id">
                          <div class="rounded-lg border border-white/10 bg-surface-800/40 p-4">
                            <p class="text-sm font-semibold text-white">Connect GitHub Copilot</p>
                            <p class="mt-1 text-xs leading-relaxed text-gray-500">GitHub device auth creates or refreshes a Copilot upstream for the signed-in account.</p>
                            <button type="button" @click="closeUpstreamModal(); startGithubAuth()" class="btn-primary mt-3 w-full sm:w-auto" :disabled="deviceFlow.loading">
                              <span x-show="!deviceFlow.loading">Connect GitHub</span>
                              <span x-show="deviceFlow.loading" class="flex items-center gap-1.5"> ${spinner('h-3 w-3')} Connecting… </span>
                            </button>
                          </div>
                        </template>

                        <template x-if="upstreamModal.id">
                          <div class="rounded-lg border border-white/10 bg-surface-800/40 p-3">
                            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div class="flex min-w-0 items-center gap-3">
                                <img x-show="upstreamModal.copilotUser?.avatar_url" :src="upstreamModal.copilotUser?.avatar_url" alt="" class="h-10 w-10 shrink-0 rounded-lg ring-1 ring-white/10" />
                                <div class="min-w-0">
                                  <p class="truncate text-sm font-semibold text-white" x-text="upstreamModal.copilotUser?.name || upstreamModal.copilotUser?.login || 'GitHub Copilot'"></p>
                                  <p class="truncate text-xs text-gray-500">
                                    <span x-text="upstreamModal.copilotUser?.login ? '@' + upstreamModal.copilotUser.login : 'Connected account'"></span>
                                    <span class="mx-1 text-gray-700">·</span>
                                    <span x-text="upstreamModal.accountType || 'copilot'"></span>
                                  </p>
                                </div>
                              </div>
                              <button type="button" @click="loadCopilotQuotaForModal()" class="btn-ghost !py-2 !px-3 text-xs" :disabled="upstreamModal.copilotQuota.loading">
                                <span x-show="!upstreamModal.copilotQuota.loading">Refresh Quota</span>
                                <span x-show="upstreamModal.copilotQuota.loading" class="flex items-center gap-1.5"> ${spinner('h-3 w-3')} Loading… </span>
                              </button>
                            </div>

                            <div class="mt-3 border-t border-white/[0.06] pt-3">
                              <p class="mb-2 text-xs font-medium text-gray-500">Copilot quota</p>
                              <template x-if="upstreamModal.copilotQuota.loading">
                                <div class="flex flex-col gap-2">
                                  <div class="h-2 rounded bg-surface-600 animate-pulse"></div>
                                  <div class="grid grid-cols-3 gap-2">
                                    <div class="h-12 rounded bg-surface-600 animate-pulse"></div>
                                    <div class="h-12 rounded bg-surface-600 animate-pulse"></div>
                                    <div class="h-12 rounded bg-surface-600 animate-pulse"></div>
                                  </div>
                                </div>
                              </template>
                              <template x-if="upstreamModal.copilotQuota.error">
                                <p class="break-words text-sm text-red-300" x-text="upstreamModal.copilotQuota.error"></p>
                              </template>
                              <template x-if="upstreamModal.copilotQuota.data">
                                <div>
                                  <div class="progress-track">
                                    <div
                                      class="progress-fill"
                                      :class="upstreamModal.copilotQuota.percent > 90 ? 'bg-accent-rose' : upstreamModal.copilotQuota.percent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-rose' : 'bg-gradient-to-r from-accent-cyan to-accent-emerald'"
                                      :style="'width:' + upstreamModal.copilotQuota.percent + '%'"
                                    ></div>
                                  </div>
                                  <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    <div class="rounded-md border border-white/5 bg-surface-900/40 p-2">
                                      <p class="text-xs font-medium text-gray-500">Premium</p>
                                      <p class="mt-0.5 font-mono text-sm font-semibold text-white">
                                        <span x-text="upstreamModal.copilotQuota.data.quota_snapshots.premium_interactions.remaining"></span>
                                        <span class="text-gray-600"> / </span>
                                        <span x-text="upstreamModal.copilotQuota.data.quota_snapshots.premium_interactions.entitlement"></span>
                                      </p>
                                    </div>
                                    <div class="rounded-md border border-white/5 bg-surface-900/40 p-2">
                                      <p class="text-xs font-medium text-gray-500">Chat</p>
                                      <p class="mt-0.5 font-mono text-sm font-semibold text-white" x-text="upstreamModal.copilotQuota.data.quota_snapshots.chat.unlimited ? '\u221e' : upstreamModal.copilotQuota.data.quota_snapshots.chat.remaining"></p>
                                    </div>
                                    <div class="rounded-md border border-white/5 bg-surface-900/40 p-2">
                                      <p class="text-xs font-medium text-gray-500">Resets</p>
                                      <p class="mt-0.5 truncate text-xs font-medium text-white" x-text="formatDate(upstreamModal.copilotQuota.data.quota_reset_date)"></p>
                                    </div>
                                  </div>
                                </div>
                              </template>
                            </div>
                          </div>
                        </template>
                      </div>
                    </template>

                    <div class="flex flex-col gap-3">
                      <div>
                        <button
                          type="button"
                          @click="upstreamModal.flagOverridesOpen = !upstreamModal.flagOverridesOpen"
                          :aria-expanded="upstreamModal.flagOverridesOpen.toString()"
                          class="mb-2 flex w-full items-center justify-between text-left text-xs font-medium text-gray-500 transition-colors hover:text-gray-300"
                        >
                          <span class="flex items-center gap-1.5">
                            <span>Feature Flags</span>
                            <span x-show="Object.keys(upstreamModal.flagOverrides).length > 0" class="font-mono text-[10px] text-accent-cyan" x-text="'(+' + Object.keys(upstreamModal.flagOverrides).length + ')'"></span>
                          </span>
                          <span class="flex items-center gap-2 normal-case tracking-normal text-[10px] text-gray-600">
                            <svg class="h-3 w-3 transition-transform" :class="upstreamModal.flagOverridesOpen ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </span>
                        </button>
                        <div x-show="upstreamModal.flagOverridesOpen" x-cloak>
                          <p x-show="upstreamFlagCatalog.length === 0" class="text-[11px] text-gray-600">No flags are registered.</p>
                          <div x-show="upstreamFlagCatalog.length > 0" class="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-surface-800/40 px-3 divide-y divide-white/[0.06]">
                            <template x-for="flag in upstreamFlagCatalog" :key="flag.id">
                              <div class="flex items-start justify-between gap-3 py-2.5">
                                <div class="min-w-0">
                                  <span class="block break-all font-mono text-xs text-white" x-text="flag.label || flag.id"></span>
                                  <span x-show="flag.description" class="mt-0.5 block text-[11px] text-gray-500" x-text="flag.description"></span>
                                </div>
                                <div class="flex shrink-0 items-center gap-1 text-[11px]">
                                  <template x-for="state in ['inherit', 'on', 'off']" :key="state">
                                    <label class="flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5"
                                      :class="flagPillClass(state, upstreamFlagState(flag.id) === state, upstreamFlagInheritedFrom(flag))">
                                      <input type="radio" class="hidden" :name="'flag-' + flag.id" :value="state" :checked="upstreamFlagState(flag.id) === state" @change="setUpstreamFlagState(flag.id, state)" />
                                      <span x-text="state === 'inherit' ? 'Inherit: ' + upstreamFlagInheritedFrom(flag) : state === 'on' ? 'On' : 'Off'"></span>
                                    </label>
                                  </template>
                                </div>
                              </div>
                            </template>
                          </div>
                        </div>
                      </div>
                    </div>

                    <template x-if="upstreamModal.id && upstreamTestResult">
                      <div class="rounded-md border p-3" :class="upstreamTestResult.ok ? 'border-accent-emerald/20 bg-accent-emerald/5' : 'border-red-500/20 bg-red-500/5'">
                        <p class="mb-1 text-xs font-medium" :class="upstreamTestResult.ok ? 'text-accent-emerald' : 'text-red-300'" x-text="upstreamTestTitle()"></p>
                        <p class="break-all text-[11px] text-gray-400" x-text="upstreamTestDetail()"></p>
                      </div>
                    </template>

                    <template x-if="upstreamModal.error">
                      <p class="break-words rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-300" x-text="upstreamModal.error"></p>
                    </template>
                  </div>
                </div>

                <div class="flex flex-col gap-2 border-t border-white/[0.06] px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
                  <button
                    x-show="upstreamModal.id"
                    type="button"
                    @click="testUpstream(upstreamModal.id)"
                    class="btn-ghost order-2 sm:order-1"
                    :disabled="upstreamTestingId === upstreamModal.id || upstreamModal.saving"
                  >
                    <span x-show="upstreamTestingId !== upstreamModal.id">Test Upstream</span>
                    <span x-show="upstreamTestingId === upstreamModal.id" class="flex items-center justify-center gap-1.5"> ${spinner('h-3 w-3')} Testing… </span>
                  </button>
                  <button @click="closeUpstreamModal()" class="btn-ghost order-3 sm:order-2">Cancel</button>
                  <button
                    x-show="upstreamModal.provider !== 'copilot' || upstreamModal.id"
                    @click="saveUpstream()"
                    class="btn-primary order-1 sm:order-3"
                    :disabled="upstreamModal.saving || !upstreamModal.name.trim()"
                  >
                    <span x-show="!upstreamModal.saving">Save</span>
                    <span x-show="upstreamModal.saving" class="flex items-center justify-center gap-2"> ${spinner('h-4 w-4')} Saving… </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div class="flex flex-col gap-5">
            ${renderUpstreamsSettingsCard()}

            <div class="glass-card p-5 sm:p-6 animate-in delay-2">
              <div class="mb-4">
                <h3 class="text-white font-semibold mb-1">Web Search</h3>
                <p class="text-sm text-gray-400">Configure the search provider used by Anthropic Messages web search.</p>
              </div>

              <template x-if="!searchConfigLoaded">
                <div class="space-y-4">
                  <div class="flex items-center gap-2 text-xs text-gray-500">
                    ${spinner('h-3.5 w-3.5 text-gray-500')}
                    <span>Loading saved search config…</span>
                  </div>
                  <div class="grid grid-cols-1 gap-3">
                    <div class="h-20 rounded-xl bg-surface-600 animate-pulse"></div>
                    <div class="h-20 rounded-xl bg-surface-600 animate-pulse"></div>
                    <div class="h-20 rounded-xl bg-surface-600 animate-pulse"></div>
                  </div>
                  <div class="space-y-2">
                    <div class="h-4 w-32 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-11 bg-surface-600 rounded-lg animate-pulse"></div>
                  </div>
                </div>
              </template>

              <template x-if="searchConfigLoaded">
                <div class="space-y-5">
                  <div>
                    <p class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3">Search Provider</p>
                    <div class="grid grid-cols-1 gap-3">
                      <label
                        class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
                        :class="searchConfigDraft.provider === 'disabled' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                      >
                        <input
                          type="radio"
                          name="search-provider"
                          value="disabled"
                          class="accent-accent-cyan"
                          :checked="searchConfigDraft.provider === 'disabled'"
                          :disabled="!searchConfigLoaded"
                          @change="setSearchConfigProvider('disabled')"
                        />
                        <div>
                          <p class="text-sm font-medium text-white">Disabled</p>
                          <p class="text-xs text-gray-500">No upstream web search provider</p>
                        </div>
                      </label>

                      <label
                        class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
                        :class="searchConfigDraft.provider === 'tavily' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                      >
                        <input
                          type="radio"
                          name="search-provider"
                          value="tavily"
                          class="accent-accent-cyan"
                          :checked="searchConfigDraft.provider === 'tavily'"
                          :disabled="!searchConfigLoaded"
                          @change="setSearchConfigProvider('tavily')"
                        />
                        <div>
                          <p class="text-sm font-medium text-white">Tavily</p>
                          <p class="text-xs text-gray-500">Gateway-managed Tavily API key</p>
                        </div>
                      </label>

                      <label
                        class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
                        :class="searchConfigDraft.provider === 'microsoft-grounding' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                      >
                        <input
                          type="radio"
                          name="search-provider"
                          value="microsoft-grounding"
                          class="accent-accent-cyan"
                          :checked="searchConfigDraft.provider === 'microsoft-grounding'"
                          :disabled="!searchConfigLoaded"
                          @change="setSearchConfigProvider('microsoft-grounding')"
                        />
                        <div>
                          <p class="text-sm font-medium text-white">Microsoft Grounding</p>
                          <p class="text-xs text-gray-500">Gateway-managed Microsoft Grounding key</p>
                        </div>
                      </label>
                    </div>
                  </div>

                  <div>
                    <label class="block text-xs font-medium text-gray-500 uppercase tracking-widest mb-2" x-text="searchCredentialLabel"></label>
                    <input
                      type="password"
                      autocomplete="off"
                      :placeholder="searchConfigDraft.provider === 'tavily' ? 'Tavily API key' : searchConfigDraft.provider === 'microsoft-grounding' ? 'Microsoft Grounding API key' : 'No credential needed when disabled'"
                      :value="searchCredentialValue"
                      @input="setSearchCredentialValue($event.target.value)"
                      :disabled="!searchConfigLoaded || searchConfigDraft.provider === 'disabled'"
                      class="w-full"
                    />
                  </div>

                  <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <button @click="saveSearchConfig()" class="btn-primary w-full sm:w-auto" :disabled="!searchConfigLoaded || searchConfigSaving">
                      <span x-show="!searchConfigSaving">Save Search Config</span>
                      <span x-show="searchConfigSaving" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Saving… </span>
                    </button>

                    <button @click="testSearchConfig()" class="btn-ghost w-full sm:w-auto" :disabled="!searchConfigLoaded || searchConfigTesting || searchConfigDraft.provider === 'disabled'">
                      <span x-show="!searchConfigTesting">Test Search</span>
                      <span x-show="searchConfigTesting" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Testing… </span>
                    </button>

                    <p class="text-xs text-gray-500" x-show="searchConfigDraft.provider === 'disabled'">Search testing is disabled until a provider is selected.</p>
                  </div>

                  <template x-if="searchConfigTestResult">
                    <div class="bg-surface-900 rounded-xl border border-white/5 p-4">
                      <div class="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
                        <div class="min-w-0">
                          <p class="text-sm font-medium text-white">Search Test Result</p>
                          <p class="text-xs text-gray-500">Provider: <span x-text="searchConfigTestResult.provider"></span> · Query: <span x-text="searchConfigTestResult.query"></span></p>
                        </div>
                        <span
                          class="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
                          :class="searchConfigTestResult.ok ? 'bg-accent-emerald/10 text-accent-emerald' : 'bg-red-500/10 text-red-400'"
                          x-text="searchConfigTestResult.ok ? 'OK' : 'Error'"
                        ></span>
                      </div>

                      <template x-if="searchConfigTestResult.ok">
                        <div class="space-y-3">
                          <template x-for="result in searchConfigTestResult.results" :key="result.url + result.title">
                            <div class="rounded-lg border border-white/5 bg-surface-800 p-3">
                              <div class="flex items-start justify-between gap-3 mb-1">
                                <div>
                                  <a :href="result.url" target="_blank" class="text-sm font-medium text-accent-cyan hover:underline break-words" x-text="result.title"></a>
                                  <p class="text-[11px] text-gray-500 break-all" x-text="result.url"></p>
                                </div>
                                <span class="text-[10px] text-gray-600 uppercase tracking-widest" x-show="result.pageAge" x-text="result.pageAge"></span>
                              </div>
                              <p class="text-sm text-gray-300 leading-relaxed" x-text="result.previewText"></p>
                            </div>
                          </template>
                        </div>
                      </template>

                      <template x-if="!searchConfigTestResult.ok">
                        <div class="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                          <p class="text-sm text-red-300 font-medium" x-text="searchConfigTestResult.error.code"></p>
                          <p class="text-sm text-gray-300 mt-1" x-text="searchConfigTestResult.error.message"></p>
                        </div>
                      </template>
                    </div>
                  </template>
                </div>
              </template>
            </div>
          </div>

          <div class="flex flex-col gap-5">
            <div class="glass-card p-5 sm:p-6 animate-in delay-1">
              <h3 class="text-white font-semibold mb-4">API Endpoints</h3>
              <div class="min-w-0">
                ${endpointRow('POST', '/v1/messages', 'Anthropic Messages', 'https://docs.anthropic.com/en/api/messages')}
                ${endpointRow('POST', '/v1/messages/count_tokens', 'Anthropic Count Tokens', 'https://docs.anthropic.com/en/api/messages-count-tokens')}
                ${endpointRow('POST', '/v1/responses', 'OpenAI Responses', 'https://platform.openai.com/docs/api-reference/responses/create')}
                ${endpointRow('POST', '/v1/chat/completions', 'OpenAI Chat Completions', 'https://platform.openai.com/docs/api-reference/chat/create')}
                ${endpointRow('POST', '/v1/embeddings', 'OpenAI Embeddings', 'https://platform.openai.com/docs/api-reference/embeddings/create')}
                ${endpointRow('GET', '/v1/models', 'OpenAI Models', 'https://platform.openai.com/docs/api-reference/models/list')}
              </div>
            </div>

            <div class="glass-card p-5 sm:p-6 animate-in delay-2">
              <h3 class="text-white font-semibold mb-1">Export Data</h3>
              <p class="text-sm text-gray-400 mb-4">Download API keys, upstreams, web search config, and usage data as a JSON file.</p>
              <label class="mb-4 flex items-start gap-3 rounded-md border border-white/5 bg-surface-800/50 p-3">
                <input type="checkbox" class="mt-0.5 h-4 w-4 rounded border-white/10 bg-surface-900 text-accent-cyan" x-model="exportIncludePerformance" />
                <span>
                  <span class="block text-sm font-medium text-gray-200"> Include Performance Telemetry </span>
                  <span class="block text-xs text-gray-500"> Adds latency histogram history to the export. </span>
                </span>
              </label>
              <button @click="exportData()" class="btn-primary" :disabled="exportLoading">
                <span x-show="!exportLoading" class="flex items-center gap-2">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export JSON
                </span>
                <span x-show="exportLoading" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Exporting… </span>
              </button>

              <div class="my-6 border-t border-white/[0.06]"></div>

              <h3 class="text-white font-semibold mb-1">Import Data</h3>
              <p class="text-sm text-gray-400 mb-4">Restore data from a previously exported JSON file.</p>

              <div class="mb-4">
                <label
                  class="block w-full cursor-pointer border-2 border-dashed border-white/10 hover:border-accent-cyan/30 rounded-xl p-8 text-center transition-colors"
                  :class="importFile ? 'border-accent-cyan/40 bg-accent-cyan/5' : ''"
                >
                  <input type="file" accept=".json" class="hidden" @change="handleImportFile($event)" />
                  <template x-if="!importFile">
                    <div>
                      <svg class="w-8 h-8 mx-auto mb-2 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <p class="text-sm text-gray-400">Click to select a JSON export file</p>
                    </div>
                  </template>
                  <template x-if="importFile">
                    <div>
                      <svg class="w-8 h-8 mx-auto mb-2 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <p class="text-sm text-white break-all" x-text="importFile.name"></p>
                      <p class="text-xs text-gray-500 mt-1" x-text="'Exported: ' + (importPreview.exportedAt ? new Date(importPreview.exportedAt).toLocaleString() : 'unknown')"></p>
                    </div>
                  </template>
                </label>
              </div>

              <template x-if="importPreview.ready">
                <div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">API Keys</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.apiKeys"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Upstream Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.upstreams"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Usage Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.usage"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Search Usage Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.searchUsage"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Performance Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.performance"></p>
                    </div>
                  </div>

                  <div class="flex flex-col gap-3 mb-4 sm:flex-row">
                    <button
                      @click="importMode = 'merge'"
                      class="flex-1 p-3 rounded-lg border text-left transition-all"
                      :class="importMode === 'merge' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                    >
                      <p class="text-sm font-medium" :class="importMode === 'merge' ? 'text-accent-cyan' : 'text-white'">Merge</p>
                      <p class="text-xs text-gray-500 mt-0.5">Keep existing data, add/update imported records</p>
                    </button>
                    <button
                      @click="importMode = 'replace'"
                      class="flex-1 p-3 rounded-lg border text-left transition-all"
                      :class="importMode === 'replace' ? 'border-red-400/50 bg-red-400/5' : 'border-white/10 hover:border-white/20'"
                    >
                      <p class="text-sm font-medium" :class="importMode === 'replace' ? 'text-red-400' : 'text-white'">Replace</p>
                      <p class="text-xs text-gray-500 mt-0.5">Wipe all existing data and restore from file</p>
                    </button>
                  </div>

                  <template x-if="importMode === 'replace'">
                    <div class="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4">
                      <p class="text-sm text-red-400">This will permanently delete all existing data before importing. This cannot be undone.</p>
                    </div>
                  </template>

                  <button @click="doImport()" class="btn-primary w-full sm:w-auto" :disabled="importLoading" :class="importMode === 'replace' ? 'bg-red-500/80 hover:bg-red-500' : ''">
                    <span x-show="!importLoading" class="flex items-center gap-2">
                      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span x-text="importMode === 'replace' ? 'Replace All Data' : 'Merge Data'"></span>
                    </span>
                    <span x-show="importLoading" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Importing… </span>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>
  `;
}

export function renderModelsTab() {
  return html`
    <div x-show="tab === 'models'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
      <div class="glass-card glow-border animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row">
        <!-- Left: Model list -->
        <div class="max-h-56 w-full shrink-0 border-b border-white/[0.06] flex flex-col lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
          <div class="p-3 border-b border-white/[0.06]">
            <input type="text" x-model="modelsSearch" placeholder="Filter models..." style="padding:8px 12px; font-size:12px; border-radius:8px;" />
          </div>
          <div class="flex-1 overflow-y-auto">
            <template x-for="(m, i) in filteredChatModels" :key="m.id">
              <button
                @click="selectChatModel(m.id)"
                class="w-full min-h-11 text-left px-4 py-2.5 transition-colors border-l-2"
                :class="[chatModelId === m.id
                  ? 'bg-accent-cyanGlow text-accent-cyan border-l-accent-cyan'
                  : 'text-gray-400 hover:bg-white/[0.03] hover:text-gray-200 border-l-transparent',
                  i < filteredChatModels.length - 1 ? 'border-b border-white/[0.03]' : '']"
              >
                <div class="text-[13px] truncate" :class="chatModelId === m.id ? 'text-white' : 'text-gray-300'" x-text="m.name"></div>
                <div class="text-[11px] font-mono truncate mt-0.5 opacity-60" x-text="m.id"></div>
              </button>
            </template>
            <div x-show="filteredChatModels.length === 0" class="p-4 text-center text-gray-600 text-xs">No models found</div>
          </div>
        </div>

        <!-- Right: Info + Chat -->
        <div class="flex-1 flex flex-col min-w-0 min-h-0">
          <!-- Model info bar -->
          <div x-show="chatModelInfo" class="shrink-0 p-4 border-b border-white/[0.06]">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2">
                  <h3 class="text-sm font-semibold text-white" x-text="chatModelInfo?.name"></h3>
                  <span x-show="chatModelInfo && chatModelInfo.name !== chatModelInfo.id" class="font-mono text-[11px] text-gray-500 break-all" x-text="chatModelInfo?.id"></span>
                </div>
                <div class="flex flex-wrap gap-1.5 mt-2">
                  <template x-for="binding in (chatModelInfo?.upstreams || [])" :key="binding.id">
                    <span
                      class="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
                      :class="providerBadgeClass(binding.kind)"
                      :title="providerLabel(binding.kind) + ' · ' + binding.name"
                      x-text="binding.name"
                    ></span>
                  </template>
                  <template x-if="chatModelInfo?.limits?.max_context_window_tokens">
                    <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
                      context: <span x-text="formatTokenLimit(chatModelInfo.limits.max_context_window_tokens)"></span>
                    </span>
                  </template>
                  <template x-if="chatModelInfo?.limits?.max_prompt_tokens">
                    <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
                      prompt: <span x-text="formatTokenLimit(chatModelInfo.limits.max_prompt_tokens)"></span>
                    </span>
                  </template>
                  <template x-if="chatModelInfo?.limits?.max_output_tokens">
                    <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
                      output: <span x-text="formatTokenLimit(chatModelInfo.limits.max_output_tokens)"></span>
                    </span>
                  </template>
                </div>
              </div>
              <button @click="clearChat()" class="btn-ghost text-[11px] flex shrink-0 items-center gap-1" :disabled="chatMessages.length === 0">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Clear
              </button>
            </div>
          </div>

          <div x-show="!chatModelInfo" class="flex-1 flex items-center justify-center text-gray-600 text-sm">Select a model to begin</div>

          <!-- Chat messages -->
          <div x-show="chatModelInfo" class="flex-1 overflow-y-auto p-4 space-y-3" x-ref="chatScroll">
            <div x-show="chatMessages.length === 0 && !chatSending" class="flex items-center justify-center h-full text-gray-600 text-xs">Send a message to start chatting</div>
            <template x-for="(msg, i) in chatMessages" :key="i">
              <div class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
                <div
                  class="max-w-[86%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm break-words"
                  :class="msg.role === 'user'
                      ? 'bg-accent-cyan/10 text-gray-200 rounded-br-md'
                      : 'bg-surface-600 text-gray-300 rounded-bl-md'"
                >
                  <template x-if="msg.imageUrl"><img :src="msg.imageUrl" class="max-w-full max-h-48 rounded-lg mb-2" /></template><span x-text="msg.text" style="white-space: pre-wrap;"></span>
                </div>
              </div>
            </template>
            <div x-show="chatSending && (chatMessages.length === 0 || chatMessages[chatMessages.length-1].role === 'user')" class="flex justify-start">
              <div class="bg-surface-600 rounded-2xl rounded-bl-md px-4 py-2.5">
                <span class="inline-flex gap-1">
                  <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay:0s"></span>
                  <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay:0.15s"></span>
                  <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay:0.3s"></span>
                </span>
              </div>
            </div>
          </div>

          <!-- Input -->
          <div x-show="chatModelInfo" class="shrink-0 p-3 border-t border-white/[0.06]">
            <div class="flex flex-col gap-2 mb-2 sm:flex-row sm:items-center" x-show="chatShowImage">
              <input type="text" x-model="chatImageUrl" placeholder="Image URL (optional)" style="padding:6px 10px; font-size:11px; border-radius:8px;" />
              <button @click="chatShowImage = false; chatImageUrl = ''" class="text-gray-600 hover:text-gray-400 text-[11px] self-start sm:self-auto">cancel</button>
            </div>
            <div class="flex gap-2">
              <button
                @click="chatShowImage = !chatShowImage"
                class="shrink-0 min-h-11 min-w-11 p-2 rounded-lg bg-surface-600 text-gray-500 hover:text-accent-cyan transition-colors inline-flex items-center justify-center"
                aria-label="Attach image URL"
                title="Attach image URL"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              </button>
              <textarea
                x-model="chatInput"
                @keydown.enter="if (!$event.shiftKey) { $event.preventDefault(); sendChatMessage(); }"
                placeholder="Type a message..."
                rows="2"
                style="font-size:13px; padding:10px 14px; min-height:42px; max-height:200px;"
                :disabled="chatSending"
              ></textarea>
              <button
                @click="sendChatMessage()"
                :disabled="chatSending || (!chatInput.trim() && !chatImageUrl.trim())"
                class="btn-primary shrink-0 flex items-center gap-1"
                style="padding:8px 16px; border-radius:10px; font-size:13px;"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
                <span x-text="chatSending ? '\\u2026' : 'Send'"></span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
