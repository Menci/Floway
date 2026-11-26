import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ScrollArea } from '../../../src/components/ui/scroll-area';

describe('ScrollArea', () => {
  it('isolates its host stacking context so scrolled controls stay beneath sibling sticky bars', () => {
    const { container } = render(
      <ScrollArea axes="vertical">
        <div>content</div>
      </ScrollArea>,
    );
    const host = container.querySelector('.floway-scroll-area');
    expect(host).not.toBeNull();
    expect(host!.classList.contains('isolate')).toBe(true);
  });
});
