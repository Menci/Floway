import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import { useCallback, useMemo, useRef, useState } from 'react';

import { modelGroupMatcher } from './model-groups';
import { updateOwnPreferences } from '../../api/auth';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useUserPreferences } from '../../lib/use-preferences';
import { useAuthStore } from '../../stores/auth-store';
import { DialogShell } from '../ui/dialog-shell';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { moveItem, ReorderHandle, useReorderList } from '../ui/reorder-list';
import { SectionHeader } from '../ui/section-header';
import { SettingsCard } from '../ui/settings-card';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { useDiscardGuard } from '../ui/use-discard-guard';
import { USAGE_MODEL_GROUP_LIMITS, USAGE_OTHER_SHARES, type UsageModelGroup, type UsageOtherShare } from '@floway-dev/protocols/browser';

const { Button, DialogActions, DialogTitle, Field, Option, Text, Tooltip } = fluentComponents;

interface DraftRow { key: number; pattern: string; name: string }

type RowIssue = 'required' | 'patternTooLong' | 'nameTooLong';

const rowIssues = (row: DraftRow): { pattern?: RowIssue; name?: RowIssue } => {
  const pattern = row.pattern.trim();
  const name = row.name.trim();
  // A row left wholly blank is an unused slot and is dropped on save.
  if (pattern === '' && name === '') return {};
  return {
    ...(pattern === '' ? { pattern: 'required' as const } : pattern.length > USAGE_MODEL_GROUP_LIMITS.pattern ? { pattern: 'patternTooLong' as const } : {}),
    ...(name === '' ? { name: 'required' as const } : name.length > USAGE_MODEL_GROUP_LIMITS.name ? { name: 'nameTooLong' as const } : {}),
  };
};

/**
 * Edits the signed-in user's Usage model groups and Other share. `models` are
 * the raw models of the chart that opened it, for previewing what each pattern
 * claims; the settings page has no chart and passes null.
 */
export function ModelGroupsDialog({ models, onOpenChange, open }: {
  models: readonly string[] | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const saved = useUserPreferences();
  const replacePreferences = useAuthStore(state => state.replacePreferences);
  const nextKey = useRef(saved.usageModelGroups.length);
  const [rows, setRows] = useState<DraftRow[]>(() => saved.usageModelGroups.map((group, key) => ({ key, ...group })));
  const [otherShare, setOtherShare] = useState<UsageOtherShare>(saved.usageOtherShare);
  const [showIssues, setShowIssues] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const reorder = useReorderList({ busy: saving, length: rows.length, onReorder: (from, to) => setRows(current => moveItem(current, from, to)) });
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values: { rows: rows.map(({ pattern, name }) => ({ pattern, name })), otherShare } });

  const issues = rows.map(rowIssues);
  const valid = issues.every(issue => issue.pattern === undefined && issue.name === undefined);
  const groups: UsageModelGroup[] = rows
    .map(row => ({ pattern: row.pattern.trim(), name: row.name.trim() }))
    .filter(group => group.pattern !== '' && group.name !== '');

  const preview = useMemo(() => {
    if (models === null) return null;
    const usable = rows.flatMap((row, index) => row.pattern.trim() === '' ? [] : [{ index, group: { pattern: row.pattern, name: row.name } }]);
    const match = modelGroupMatcher(usable.map(entry => entry.group));
    const claimed = new Map<number, string[]>();
    const ungrouped: string[] = [];
    for (const model of models) {
      const hit = match(model);
      if (hit === -1) ungrouped.push(model);
      else claimed.set(usable[hit]!.index, [...claimed.get(usable[hit]!.index) ?? [], model]);
    }
    return { claimed, ungrouped };
  }, [models, rows]);

  const patchRow = (key: number, patch: Partial<DraftRow>) => setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row));
  const addRow = () => setRows(current => [...current, { key: nextKey.current++, pattern: '', name: '' }]);
  const issueText = (issue: RowIssue | undefined) => issue === undefined || !showIssues ? undefined : t(`monitoring.usage.modelGroups.issues.${issue}`, {
    limit: issue === 'patternTooLong' ? USAGE_MODEL_GROUP_LIMITS.pattern : USAGE_MODEL_GROUP_LIMITS.name,
  });

  const save = async () => {
    if (saving) return;
    if (!valid) { setShowIssues(true); return; }
    setSaving(true);
    setServerError(null);
    try {
      const result = await updateOwnPreferences({ usageModelGroups: groups, usageOtherShare: otherShare });
      if (result.error) { setServerError(result.error.message); return; }
      replacePreferences(result.data.preferences);
      onOpenChange(false);
      toasts.succeed(t('monitoring.usage.modelGroups.saved'));
    } finally {
      setSaving(false);
    }
  };

  const shareLabel = (share: UsageOtherShare) => share === 0
    ? t('monitoring.usage.modelGroups.other.off')
    : t('monitoring.usage.modelGroups.other.below', { share });

  return <>{discardConfirmation}<DialogShell
    width="editor"
    open={open}
    onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
    onSubmit={() => void save()}
    title={<DialogTitle>{t('monitoring.usage.modelGroups.title')}</DialogTitle>}
    actions={<DialogActions>
      <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t('monitoring.usage.modelGroups.save')}</Button>
    </DialogActions>}
  >
    <section {...reorder.listProps('grid gap-2')} role="group" aria-labelledby="usage-model-groups-heading">
      <SectionHeader
        description={t('monitoring.usage.modelGroups.description')}
        level={3}
        title={t('monitoring.usage.modelGroups.heading')}
        titleId="usage-model-groups-heading"
        actions={<Button className="!whitespace-nowrap" disabled={saving || rows.length >= USAGE_MODEL_GROUP_LIMITS.groups} icon={<AddRegular />} onClick={addRow}>{t('monitoring.usage.modelGroups.add')}</Button>}
      />
      {rows.map((row, index) => {
        const claimed = preview?.claimed.get(index) ?? [];
        return <div {...reorder.itemProps(index, 'grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-start max-[620px]:grid-cols-[auto_minmax(0,1fr)_auto]')} key={row.key}
          role="group" aria-label={t('monitoring.usage.modelGroups.row', { number: index + 1 })}>
          <div className="pt-1"><ReorderHandle {...reorder.handleProps(index)} label={t('monitoring.usage.modelGroups.reorder')} /></div>
          <Field label={t('monitoring.usage.modelGroups.pattern')} validationMessage={issueText(issues[index]!.pattern)} validationState={showIssues && issues[index]!.pattern ? 'error' : 'none'}
            hint={preview === null || row.pattern.trim() === '' ? undefined : <Tooltip content={claimed.length ? claimed.join(', ') : t('monitoring.usage.modelGroups.matchesNone')} relationship="description">
              <span className="winui-focus-rect" tabIndex={0}>{t('monitoring.usage.modelGroups.matches', { count: claimed.length })}</span>
            </Tooltip>}>
            <Input className="font-mono" disabled={saving} placeholder={t('monitoring.usage.modelGroups.patternPlaceholder')} value={row.pattern} onChange={(_, data) => patchRow(row.key, { pattern: data.value })} />
          </Field>
          <Field className="max-[620px]:col-start-2" label={t('monitoring.usage.modelGroups.name')} validationMessage={issueText(issues[index]!.name)} validationState={showIssues && issues[index]!.name ? 'error' : 'none'}>
            <Input disabled={saving} placeholder={t('monitoring.usage.modelGroups.namePlaceholder')} value={row.name} onChange={(_, data) => patchRow(row.key, { name: data.value })} />
          </Field>
          <div className="pt-6 max-[620px]:row-start-1 max-[620px]:col-start-3">
            <TooltipIconButton danger disabled={saving} icon={<DeleteRegular />} label={t('monitoring.usage.modelGroups.remove')} onClick={() => setRows(current => current.filter(candidate => candidate.key !== row.key))} />
          </div>
        </div>;
      })}
      {rows.length === 0 && <Text className="text-fui-fg2" size={200}>{t('monitoring.usage.modelGroups.empty')}</Text>}
      {preview !== null && preview.ungrouped.length > 0 && <Tooltip content={preview.ungrouped.join(', ')} relationship="description">
        <Text className="winui-focus-rect text-fui-fg2 justify-self-start" size={200} tabIndex={0}>{t('monitoring.usage.modelGroups.ungrouped', { count: preview.ungrouped.length })}</Text>
      </Tooltip>}
    </section>
    <SettingsCard
      action={<Dropdown
        aria-label={t('monitoring.usage.modelGroups.other.title')}
        disabled={saving}
        onOptionSelect={(_, data) => {
          if (data.optionValue === undefined) return;
          setOtherShare(Number(data.optionValue) as UsageOtherShare);
        }}
        selectedOptions={[String(otherShare)]}
        value={shareLabel(otherShare)}
      >
        {USAGE_OTHER_SHARES.map(share => <Option key={share} text={shareLabel(share)} value={String(share)}>{shareLabel(share)}</Option>)}
      </Dropdown>}
      description={t('monitoring.usage.modelGroups.other.description')}
      header={t('monitoring.usage.modelGroups.other.title')}
    />
    {serverError && <OutcomeMessageBar onDismiss={() => setServerError(null)}>{serverError}</OutcomeMessageBar>}
  </DialogShell></>;
}
