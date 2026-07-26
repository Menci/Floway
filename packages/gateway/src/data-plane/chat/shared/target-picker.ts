import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

// Build a picker from an ordered preference list of chat-target keys. The
// preference encodes which upstream wire the source protocol prefers to
// translate to, in order. The first preference whose endpoint key exists
// on the candidate wins. Serve calls `canServe` to filter candidates whose
// upstream wire cannot satisfy any preferred target; attempt calls `pick`
// once it has a viable candidate to choose the dispatch wire. `pick` is
// contractually total — a null return would mean the serve-side filter
// was bypassed. `canServe` is a 1-bit projection of `pick`.
export const chatTargetPicker = (preference: readonly ChatTargetApi[]): {
  canServe: (endpoints: ModelEndpoints) => boolean;
  pick: (endpoints: ModelEndpoints) => ChatTargetApi;
} => {
  const find = (endpoints: ModelEndpoints): ChatTargetApi | null => {
    for (const key of preference) {
      switch (key) {
      case 'messages':
        if (endpoints.messages) return 'messages';
        break;
      case 'responses':
        if (endpoints.responses) return 'responses';
        break;
      case 'chat-completions':
        if (endpoints.chatCompletions) return 'chat-completions';
        break;
      }
    }
    return null;
  };
  return {
    canServe: endpoints => find(endpoints) !== null,
    pick: endpoints => {
      const out = find(endpoints);
      if (out === null) throw new Error('chatTargetPicker.pick called on a candidate the picker rejects — serve must filter via canServe first');
      return out;
    },
  };
};
