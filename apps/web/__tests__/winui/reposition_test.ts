import { describe, expect, it, vi } from 'vitest';

import { createReposition } from '../../src/winui/reposition';
import { stubMatchMedia } from '../match-media-stub';

const elementAt = (readTop: () => number, animate = vi.fn()) => ({
  animate,
  get offsetTop() { return readTop(); },
}) as unknown as HTMLElement;

describe('WinUI reposition motion', () => {
  const setMedia = stubMatchMedia(() => false);

  it('does not animate a move when reduced motion is requested', () => {
    let top = 0;
    const element = elementAt(() => top);
    const reposition = createReposition();
    reposition([element]);

    setMedia(query => query.includes('(prefers-reduced-motion: reduce)'));
    top = 20;
    reposition([element]);

    expect(element.animate).not.toHaveBeenCalled();
  });

  it('cancels a running reposition when reduced motion turns on', () => {
    let top = 0;
    const animation = { cancel: vi.fn() } as unknown as Animation;
    const element = elementAt(() => top, vi.fn(() => animation));
    const reposition = createReposition();
    reposition([element]);
    top = 20;
    reposition([element]);
    expect(element.animate).toHaveBeenCalledOnce();

    setMedia(query => query.includes('(prefers-reduced-motion: reduce)'));
    top = 40;
    reposition([element]);

    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(element.animate).toHaveBeenCalledOnce();
  });
});
