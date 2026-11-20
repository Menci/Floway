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
export const chatTargetPicker = <Target extends ChatTargetApi>(preference: readonly Target[]): {
  canServe: (endpoints: ModelEndpoints) => boolean;
  pick: (endpoints: ModelEndpoints) => Target;
} => {
  const find = (endpoints: ModelEndpoints): Target | undefined => preference.find(key => endpoints[key] !== undefined);
  return {
    canServe: endpoints => find(endpoints) !== undefined,
    pick: endpoints => {
      const out = find(endpoints);
      if (out === undefined) throw new Error('chatTargetPicker.pick called on a candidate the picker rejects — serve must filter via canServe first');
      return out;
    },
  };
};
