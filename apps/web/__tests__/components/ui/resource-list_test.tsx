import { expect, test } from 'vitest';

import { ResourceListPanel } from '../../../src/components/ui/resource-list';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Table, TableBody, TableCell, TableRow } = fluentComponents;
const removedBorders = (container: HTMLElement) => [...container.querySelectorAll('tr')]
  .filter(row => getComputedStyle(row).borderBottomStyle === 'none')
  .map(row => row.textContent);

test('keeps separators between table bodies and hides only the final row edge', () => {
  const { container } = renderInApp(<ResourceListPanel><Table>
    <TableBody><TableRow><TableCell>A</TableCell></TableRow></TableBody>
    <TableBody><TableRow><TableCell>B</TableCell></TableRow><TableRow><TableCell>C</TableCell></TableRow></TableBody>
  </Table></ResourceListPanel>);
  expect(removedBorders(container)).toEqual(['C']);
});

test('keeps the visual last edge of an internal drag segment', () => {
  const { container } = renderInApp(<ResourceListPanel><Table>
    <TableBody data-reordering=""><TableRow data-reorder-edge="last"><TableCell>A</TableCell></TableRow><TableRow data-reorder-edge="first"><TableCell>B</TableCell></TableRow></TableBody>
    <TableBody><TableRow><TableCell>C</TableCell></TableRow></TableBody>
  </Table></ResourceListPanel>);
  expect(removedBorders(container)).toEqual(['C']);
});

test('hides the visual last edge only when dragging the final table body', () => {
  const { container } = renderInApp(<ResourceListPanel><Table>
    <TableBody><TableRow><TableCell>A</TableCell></TableRow></TableBody>
    <TableBody data-reordering=""><TableRow data-reorder-edge="last"><TableCell>B</TableCell></TableRow><TableRow data-reorder-edge="first"><TableCell>C</TableCell></TableRow></TableBody>
  </Table></ResourceListPanel>);
  expect(removedBorders(container)).toEqual(['B']);
});
