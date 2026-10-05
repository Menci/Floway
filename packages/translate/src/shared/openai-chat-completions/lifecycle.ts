export type ChatStreamSegment = { kind: 'reasoning' | 'text' | 'refusal'; text: string } | {
  kind: 'tool'; index: number; id?: string; name?: string; arguments?: string;
};

export interface ChatStreamSlot {
  index: number;
  kind: ChatStreamSegment['kind'];
  toolIndex?: number;
}

export type ChatStreamLifecycleEvent =
  | { type: 'open'; slot: ChatStreamSlot; id?: string; name?: string }
  | { type: 'delta'; slot: ChatStreamSlot; text: string }
  | { type: 'close'; slot: ChatStreamSlot };

interface ObjectBoundary {
  depth: number;
  quoted: boolean;
  escaped: boolean;
  started: boolean;
  complete: boolean;
}

const appendObject = (state: ObjectBoundary, text: string): void => {
  for (const char of text) {
    if (state.complete) {
      if (!/\s/.test(char)) throw new SyntaxError('Tool arguments contain data after their JSON object');
      continue;
    }
    if (state.quoted) {
      if (state.escaped) state.escaped = false;
      else if (char === '\\') state.escaped = true;
      else if (char === '"') state.quoted = false;
      continue;
    }
    if (!state.started) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new SyntaxError('Tool arguments must be a JSON object');
      state.started = true;
    }
    if (char === '"') state.quoted = true;
    else if (char === '{' || char === '[') state.depth++;
    else if (char === '}' || char === ']') {
      state.depth--;
      if (state.depth === 0) state.complete = true;
    }
  }
};

interface ToolState {
  slot: ChatStreamSlot;
  opened: boolean;
  id?: string;
  name?: string;
  arguments: string;
  boundary: ObjectBoundary;
  closed: boolean;
}

export const createChatStreamLifecycle = (warnClosedTool: (index: number) => void) => {
  let current: ChatStreamSlot | undefined;
  let nextIndex = 0;
  const tools = new Map<number, ToolState>();
  const active = new Map<number, ChatStreamSlot>();
  const close = (slot: ChatStreamSlot, events: ChatStreamLifecycleEvent[]): void => {
    active.delete(slot.index);
    events.push({ type: 'close', slot });
    if (current === slot) current = undefined;
  };
  const closeCurrentText = (events: ChatStreamLifecycleEvent[]): void => {
    if (current !== undefined && current.kind !== 'tool') close(current, events);
  };
  const appendTool = (segment: Extract<ChatStreamSegment, { kind: 'tool' }>, events: ChatStreamLifecycleEvent[], makeCurrent: boolean): void => {
    const state = tools.get(segment.index) ?? {
      slot: { index: nextIndex++, kind: 'tool' as const, toolIndex: segment.index }, opened: false,
      arguments: '', boundary: { depth: 0, quoted: false, escaped: false, started: false, complete: false }, closed: false,
    };
    tools.set(segment.index, state);
    if (state.closed) {
      warnClosedTool(segment.index);
      return;
    }
    if (segment.id !== undefined) state.id = segment.id;
    if (segment.name !== undefined) state.name = segment.name;
    const wasOpen = state.opened;
    if (segment.arguments !== undefined) {
      appendObject(state.boundary, segment.arguments);
      state.arguments += segment.arguments;
      if (state.boundary.complete) JSON.parse(state.arguments);
    }
    if (makeCurrent) current = state.slot;
    if (!state.opened && state.id !== undefined && state.name !== undefined) {
      state.opened = true;
      active.set(state.slot.index, state.slot);
      events.push({ type: 'open', slot: state.slot, id: state.id, name: state.name });
    }
    if (!state.opened) return;
    const text = wasOpen ? segment.arguments : state.arguments;
    if (text !== undefined && text.length > 0) events.push({ type: 'delta', slot: state.slot, text });
    if (state.boundary.complete) {
      state.closed = true;
      close(state.slot, events);
    }
  };
  const append = (segment: ChatStreamSegment, events: ChatStreamLifecycleEvent[]): void => {
    if (segment.kind === 'tool') {
      appendTool(segment, events, true);
      return;
    }
    if (current?.kind !== segment.kind) {
      closeCurrentText(events);
      current = { index: nextIndex++, kind: segment.kind };
      active.set(current.index, current);
      events.push({ type: 'open', slot: current });
    }
    events.push({ type: 'delta', slot: current, text: segment.text });
  };
  return {
    accept: (segments: readonly ChatStreamSegment[]): ChatStreamLifecycleEvent[] => {
      const events: ChatStreamLifecycleEvent[] = [];
      const consumed = new Set<number>();
      // Existing owners consume their deltas before a new owner changes the current slot.
      for (const [index, segment] of segments.entries()) {
        if (current === undefined || segment.kind !== current.kind || (segment.kind === 'tool' && segment.index !== current.toolIndex)) continue;
        append(segment, events);
        consumed.add(index);
      }
      for (const [index, segment] of segments.entries()) {
        if (consumed.has(index) || segment.kind !== 'tool' || !tools.has(segment.index)) continue;
        appendTool(segment, events, false);
        consumed.add(index);
      }
      for (const [index, segment] of segments.entries()) {
        if (consumed.has(index)) continue;
        closeCurrentText(events);
        append(segment, events);
      }
      return events;
    },
    finish: (): ChatStreamLifecycleEvent[] => {
      const events: ChatStreamLifecycleEvent[] = [];
      for (const state of tools.values()) {
        if (!state.opened) throw new Error('Tool call identity is incomplete at stream completion');
      }
      for (const slot of [...active.values()].toSorted((left, right) => left.index - right.index)) {
        if (slot.kind === 'tool') tools.get(slot.toolIndex!)!.closed = true;
        close(slot, events);
      }
      return events;
    },
  };
};
