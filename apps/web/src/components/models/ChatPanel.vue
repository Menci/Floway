<script setup lang="ts">
import { Input, OverlayScrollbars, Textarea, type OverlayScrollbarsInitializedEvent } from '@floway-dev/ui';
import { nextTick, ref, watch } from 'vue';

import { useAuthStore } from '../../stores/auth.ts';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
}

const props = defineProps<{ modelId: string }>();

const auth = useAuthStore();

const chatMessages = ref<Message[]>([]);
const chatInput = ref('');
const chatImageUrl = ref('');
const chatShowImage = ref(false);
const chatSending = ref(false);
const chatScrollElement = ref<HTMLElement | null>(null);

let abortController: AbortController | null = null;

// Clearing or switching models forgets in-flight messages — the chat is
// scratch space, not persistent transcript.
watch(() => props.modelId, () => { clear(); });

const scroll = () => {
  void nextTick(() => {
    if (chatScrollElement.value) chatScrollElement.value.scrollTop = chatScrollElement.value.scrollHeight;
  });
};

const onChatScrollInitialized = (event: OverlayScrollbarsInitializedEvent) => {
  chatScrollElement.value = event.contentWrapper;
};

const buildBody = (): unknown => {
  const last = chatMessages.value[chatMessages.value.length - 1];
  return {
    model: props.modelId,
    stream: true,
    messages: chatMessages.value.map((msg, i) => {
      if (msg.role === 'assistant') return { role: 'assistant', content: msg.text };
      const isLast = i === chatMessages.value.length - 1;
      if (isLast && last?.role === 'user' && last.imageUrl) {
        return {
          role: 'user',
          content: [
            ...(msg.text ? [{ type: 'text', text: msg.text }] : []),
            { type: 'image_url', image_url: { url: last.imageUrl } },
          ],
        };
      }
      return { role: 'user', content: msg.text };
    }),
  };
};

const sendChatMessage = async () => {
  const text = chatInput.value.trim();
  const img = chatImageUrl.value.trim();
  if (!text && !img) return;
  if (!props.modelId) return;

  chatMessages.value.push({ role: 'user', text: text || '(image)', imageUrl: img || undefined });
  chatInput.value = '';
  chatImageUrl.value = '';
  chatShowImage.value = false;
  chatSending.value = true;
  scroll();

  abortController = new AbortController();
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-models-playground': '1',
    };
    if (auth.authKey) headers['x-api-key'] = auth.authKey;

    const resp = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody()),
      signal: abortController.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      chatMessages.value.push({ role: 'assistant', text: `[Error ${resp.status}] ${errText}` });
      return;
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantText = '';
    let assistantIndex = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        let chunk: { choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string } };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          if (assistantIndex === -1) {
            assistantIndex = chatMessages.value.length;
            chatMessages.value.push({ role: 'assistant', text: '' });
          }
          assistantText += delta;
          chatMessages.value[assistantIndex]!.text = assistantText;
          scroll();
        }
      }
    }

    if (!assistantText) chatMessages.value.push({ role: 'assistant', text: '(empty response)' });
  } catch (e: unknown) {
    const isAbort = e instanceof Error && e.name === 'AbortError';
    if (!isAbort) chatMessages.value.push({ role: 'assistant', text: `[Error] ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    chatSending.value = false;
    abortController = null;
    scroll();
  }
};

const clear = () => {
  abortController?.abort();
  chatMessages.value = [];
};

defineExpose({ clear });
</script>

<template>
  <OverlayScrollbars
    class="min-h-0 flex-1"
    content-class="min-h-full"
    :v-scrollbar-offset="{ x: 2 }"
    @initialized="onChatScrollInitialized"
    @destroyed="chatScrollElement = null"
  >
    <div class="flex min-h-full flex-col gap-3 p-4">
      <div v-if="chatMessages.length === 0 && !chatSending" class="flex flex-1 items-center justify-center text-gray-600 text-xs">
        Send a message to start chatting
      </div>
      <div
        v-for="(msg, i) in chatMessages"
        :key="i"
        class="flex"
        :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <div
          class="max-w-[86%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm break-words"
          :class="msg.role === 'user'
            ? 'bg-accent-cyan/10 text-gray-200 rounded-br-md'
            : 'bg-surface-600 text-gray-300 rounded-bl-md'"
        >
          <img v-if="msg.imageUrl" :src="msg.imageUrl" class="max-w-full max-h-48 rounded-lg mb-2">
          <span style="white-space: pre-wrap;">{{ msg.text }}</span>
        </div>
      </div>
      <div
        v-if="chatSending && (chatMessages.length === 0 || chatMessages[chatMessages.length - 1]?.role === 'user')"
        class="flex justify-start"
      >
        <div class="bg-surface-600 rounded-2xl rounded-bl-md px-4 py-2.5">
          <span class="inline-flex gap-1">
            <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay: 0s" />
            <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay: 0.15s" />
            <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay: 0.3s" />
          </span>
        </div>
      </div>
    </div>
  </OverlayScrollbars>

  <div class="shrink-0 p-3 border-t border-white/[0.06]">
    <div v-if="chatShowImage" class="flex flex-col gap-2 mb-2 sm:flex-row sm:items-center">
      <Input
        v-model="chatImageUrl"
        type="url"
        placeholder="Image URL (optional)"
        size="sm"
      />
      <button
        class="text-gray-600 hover:text-gray-400 text-[11px] self-start sm:self-auto"
        @click="chatShowImage = false; chatImageUrl = ''"
      >
        cancel
      </button>
    </div>
    <div class="flex gap-2">
      <button
        class="shrink-0 min-h-11 min-w-11 p-2 rounded-lg bg-surface-600 text-gray-500 hover:text-accent-cyan transition-colors inline-flex items-center justify-center"
        aria-label="Attach image URL"
        title="Attach image URL"
        @click="chatShowImage = !chatShowImage"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </button>
      <Textarea
        v-model="chatInput"
        placeholder="Type a message..."
        :rows="2"
        class="flex-1 min-h-[42px] max-h-[200px]"
        :disabled="chatSending"
        @keydown.enter.exact.prevent="sendChatMessage"
      />
      <button
        :disabled="chatSending || (!chatInput.trim() && !chatImageUrl.trim())"
        class="btn-primary shrink-0 flex items-center gap-1"
        style="padding:8px 16px; border-radius:10px; font-size:13px;"
        @click="sendChatMessage"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
        <span>{{ chatSending ? '…' : 'Send' }}</span>
      </button>
    </div>
  </div>
</template>
