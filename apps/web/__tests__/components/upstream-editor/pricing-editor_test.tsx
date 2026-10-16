import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PricingEditor } from '../../../src/components/upstream-editor/pricing-editor';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import { collectModelPricingIssues, type ModelPricing } from '@floway-dev/protocols/browser';

describe('read-only pricing editor', () => {
  it('keeps one visible pricing rule selected', () => {
    const view = renderInApp(
      <PricingEditor
        kind="chat"
        onChange={vi.fn()}
        readOnly
        value={{
          entries: [
            { rates: { input_tokens: '0.000001' } },
            { selector: { serviceTier: 'priority' }, rates: { input_tokens: '0.000002' } },
          ],
        }}
      />,
    );

    const selected = view.container.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain(i18n.t('dashboard.upstreamEditor.models.pricingBase'));
  });
});

describe('scheduled pricing editor', () => {
  it('authors a weekday window with an automatic holiday calendar and preserves it on reload', () => {
    const onChange = vi.fn();
    const value = { entries: [{ rates: { input_tokens: '0.000001' } }] };
    const view = renderInApp(<PricingEditor kind="chat" value={value} onChange={onChange} readOnly={false} />);
    const text = (key: string) => i18n.t(`dashboard.upstreamEditor.models.timeWindow.${key}` as never);
    fireEvent.click(view.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.addPricingOverride') }));
    fireEvent.click(view.getByRole('checkbox', { name: text('enabled') }));
    fireEvent.change(view.getByLabelText(text('timeZone')), { target: { value: 'Asia/Shanghai' } });
    fireEvent.change(view.getByLabelText(text('start')), { target: { value: '09:00' } });
    fireEvent.change(view.getByLabelText(text('end')), { target: { value: '12:00' } });
    fireEvent.click(view.getByRole('checkbox', { name: text('saturday') }));
    fireEvent.click(view.getByRole('checkbox', { name: text('sunday') }));
    fireEvent.click(view.getByRole('checkbox', { name: text('excludeChinaHolidays') }));
    const pricing = onChange.mock.lastCall![0] as ModelPricing;
    expect(pricing.entries[1]?.selector?.timeWindow).toEqual({
      timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', excludeHolidays: 'CN',
    });
    expect(pricing.entries[1]?.rates).toEqual(value.entries[0]!.rates);
    expect(collectModelPricingIssues(pricing)).toEqual([]);
    view.unmount();
    const reloaded = renderInApp(<PricingEditor kind="chat" value={pricing} onChange={onChange} readOnly />);
    fireEvent.click(reloaded.getByText(/09:00–12:00/));
    expect((reloaded.getByLabelText(text('timeZone')) as HTMLInputElement).value).toBe('Asia/Shanghai');
    expect((reloaded.getByRole('checkbox', { name: text('excludeChinaHolidays') }) as HTMLInputElement).checked).toBe(true);
    onChange.mockClear();
    fireEvent.click(reloaded.getByRole('checkbox', { name: text('sunday') }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows invalid and overlapping time windows as pricing errors', () => {
    const window = { timeZone: 'UTC', weekdays: [1], start: '09:00', end: '12:00' };
    const view = renderInApp(<PricingEditor kind="chat" onChange={vi.fn()} readOnly value={{
      entries: [
        { rates: { input_tokens: '1' } },
        { selector: { timeWindow: window }, rates: { input_tokens: '2' } },
        { selector: { timeWindow: { ...window, end: '13:00' } }, rates: { input_tokens: '3' } },
      ],
    }} />);
    fireEvent.click(view.getByText(/09:00–12:00/));
    expect(view.getByText(i18n.t('dashboard.upstreamEditor.models.pricingIssue.timeWindowConflict'))).toBeTruthy();
  });
});
