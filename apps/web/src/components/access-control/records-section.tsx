import { AddRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { AccessRecordDialog } from './record-dialog';
import { ScopeExpression, type ScopeExpressionData } from './scope-expression';
import { api, callApi } from '../../api/client';
import type { AccessRecord, ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { SectionHeader } from '../ui/section-header';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import type { AccessPrincipal, AccessValues } from '@floway-dev/gateway/browser';

const { Button, Link, Text } = fluentComponents;

export interface InheritedAccessRecord {
  record: AccessRecord;
  sourceGroup: Pick<ControlPlaneGroup, 'id' | 'name'>;
}

export function AccessRecordsSection({ bypass = false, data, inherited = [], onChanged, onOpenInheritedSource, principal, records }: {
  bypass?: boolean;
  data: ScopeExpressionData;
  inherited?: InheritedAccessRecord[];
  onChanged: () => Promise<void>;
  onOpenInheritedSource?: (groupId: number) => void;
  principal: AccessPrincipal;
  records: AccessRecord[];
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const editor = useDialogInvocation<{ record?: AccessRecord }>();
  const deleting = useDialogInvocation<AccessRecord>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const direct = records.filter(record => record.principal.kind === principal.kind && record.principal.id === principal.id);
  const suggestedSortOrder = Math.max(-1, ...direct.map(record => record.sortOrder)) + 1;

  const remove = async (record: AccessRecord) => {
    setDeleteBusy(true);
    setDeleteError(null);
    const handle = toasts.start(t('dashboard.accessControl.toast.delete.pending'));
    const result = await callApi(() => api.api['access-records'][':id'].$delete({ param: { id: String(record.id) } }));
    setDeleteBusy(false);
    if (result.error) {
      handle.settle();
      setDeleteError(result.error.message);
      return;
    }
    handle.succeed(t('dashboard.accessControl.toast.delete.success'));
    deleting.close();
    await onChanged();
  };

  return <section className="grid gap-3 min-w-0">
    <SectionHeader
      actions={<Button appearance="subtle" disabled={bypass} icon={<AddRegular />} onClick={() => editor.open({})}>{t('dashboard.accessControl.actions.add')}</Button>}
      level={3}
      title={t('dashboard.accessControl.fields.permissions')}
    />
    {bypass && <OutcomeMessageBar intent="info">{t('dashboard.accessControl.administratorBypass')}</OutcomeMessageBar>}
    {!bypass && direct.length === 0 && inherited.length === 0
      ? <Text className="text-fui-fg2">{t('dashboard.accessControl.empty')}</Text>
      : <div className="divide-y divide-[var(--winui-divider-stroke-default)] min-w-0">
          {direct.map(record => <RecordRow
            data={data}
            key={record.id}
            onDelete={bypass ? undefined : () => { setDeleteError(null); deleting.open(record); }}
            onEdit={bypass ? undefined : () => editor.open({ record })}
            record={record}
          />)}
          {inherited.map(({ record, sourceGroup }) => <RecordRow
            data={data}
            inheritedFrom={sourceGroup}
            key={`${sourceGroup.id}:${record.id}`}
            onOpenInheritedSource={onOpenInheritedSource ? () => onOpenInheritedSource(sourceGroup.id) : undefined}
            record={record}
          />)}
        </div>}

    {editor.invocation && <AccessRecordDialog
      data={data}
      fixedPrincipal={principal}
      key={editor.invocation.key}
      onOpenChange={open => !open && editor.close()}
      onSaved={onChanged}
      open={editor.isOpen}
      record={editor.invocation.value.record}
      suggestedSortOrder={suggestedSortOrder}
    />}
    {deleting.invocation && <ConfirmDialog
      actionLabel={t('dashboard.accessControl.actions.delete')}
      busy={deleteBusy}
      error={deleteError}
      message={t('dashboard.accessControl.delete.message')}
      onConfirm={() => void remove(deleting.invocation!.value)}
      onDismissError={() => setDeleteError(null)}
      onOpenChange={open => !open && deleting.close()}
      open={deleting.isOpen}
      title={t('dashboard.accessControl.delete.title')}
    />}
  </section>;
}

function RecordRow({ data, inheritedFrom, onDelete, onEdit, onOpenInheritedSource, record }: {
  data: ScopeExpressionData;
  inheritedFrom?: Pick<ControlPlaneGroup, 'id' | 'name'>;
  onDelete?: () => void;
  onEdit?: () => void;
  onOpenInheritedSource?: () => void;
  record: AccessRecord;
}) {
  const { t } = useTranslation();
  return <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2.5 items-center min-w-0">
    <div className="grid gap-1 min-w-0">
      <ScopeExpression data={data} readOnly value={record.scope} />
      <Text className="text-fui-fg2" size={200}>
        {permissionSummary(record.values, t)}
        {inheritedFrom && <>
          {' · '}{t('dashboard.accessControl.inherited')}{' '}
          {onOpenInheritedSource
            ? <Link as="button" onClick={onOpenInheritedSource}>{inheritedFrom.name}</Link>
            : inheritedFrom.name}
        </>}
      </Text>
    </div>
    {onEdit && onDelete && <div className="flex items-center gap-1">
      <TooltipIconButton icon={<EditRegular />} label={t('dashboard.accessControl.actions.edit')} onClick={onEdit} />
      <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.accessControl.actions.delete')} onClick={onDelete} />
    </div>}
  </div>;
}

export const permissionSummary = (values: AccessValues, t: TFunction): string => Object.entries(values)
  .map(([permission, value]) => `${t(`dashboard.accessControl.permissions.${permission as keyof AccessValues}`)}: ${permissionValueLabel(value, t)}`)
  .join(' · ');

const permissionValueLabel = (value: boolean | string, t: TFunction): string => value === true
  ? t('dashboard.accessControl.states.on')
  : value === false || value === 'off'
    ? t('dashboard.accessControl.states.off')
    : value === 'models'
      ? t('dashboard.accessControl.states.models')
      : t('dashboard.accessControl.states.full');
