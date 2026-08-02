import { describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { positioningArrowBorderAtom } from '../../src/winui/flyout-arrow.css';
import { renderInApp } from '../render';

const { Popover, PopoverSurface, PopoverTrigger, Button } = fluentComponents;

const renderArrow = () =>
  renderInApp(
    <Popover open withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <Button>trigger</Button>
      </PopoverTrigger>
      <PopoverSurface>surface</PopoverSurface>
    </Popover>,
  ).baseElement.querySelector(`.${positioningArrowBorderAtom}`);

// The beak's stroke is the one part of a flyout's outline Fluent draws from a
// class it never names, so this suite is what stands between a Fluent bump that
// rehashes createArrowStyles and a flyout whose outline stops at the beak.
describe('positioning arrow border atom', () => {
  it('is the class Fluent puts on a surface arrow', () => {
    expect(renderArrow()).not.toBeNull();
  });
});
