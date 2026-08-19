import { useMemo, useState } from 'react';

import { batchUpstreamAccessStates, updateBatchUpstreamAccessChanges } from './access-state';
import { api, callApi } from '../../api/client';
import type { ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { BulkUpstreamAccessControl } from '../upstreams/access-control';

const { Button, DialogActions, DialogTitle, MessageBar, MessageBarBody } = fluentComponents;

export function UserUpstreamAccessDialog({
  models,
  onOpenChange,
  onSaved,
  open,
  upstreams,
  users,
}: {
  models: ControlPlaneModel[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  upstreams: UpstreamOption[];
  users: ControlPlaneUser[];
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const initialStates = useMemo(() => batchUpstreamAccessStates(users, upstreams.map(upstream => upstream.id)), [upstreams, users]);
  const [changes, setChanges] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const states = useMemo(() => new Map([...initialStates].map(([id, state]) => [id, changes.get(id) ?? state])), [changes, initialStates]);

  const changeAccess = (id: string, allowed: boolean) => {
    setChanges(current => updateBatchUpstreamAccessChanges(initialStates, current, id, allowed));
  };

  const save = async () => {
    if (saving || changes.size === 0) return;
    setSaving(true);
    setError(null);
    const handle = toasts.start(t('dashboard.users.toast.bulkAccess.pending', { count: users.length }));
    try {
      const result = await callApi(() => api.api.users['upstream-access'].$patch({
        json: {
          userIds: users.map(user => user.id),
          changes: [...changes].map(([upstreamId, allowed]) => ({ upstreamId, allowed })),
        },
      }));
      if (result.error) {
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t('dashboard.users.toast.bulkAccess.success', { count: users.length }));
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return <DialogShell
    width="editor"
    open={open}
    actions={<DialogActions>
      <Button disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabled={changes.size === 0} disabledFocusable={saving} type="submit">
        {t('dashboard.users.actions.save')}
      </Button>
    </DialogActions>}
    onOpenChange={(_, data) => { if (!data.open && !saving) onOpenChange(false); }}
    onSubmit={() => void save()}
    title={<DialogTitle>{t('dashboard.users.bulkAccess.title', { count: users.length })}</DialogTitle>}
  >
    <MessageBar intent="info"><MessageBarBody>{t('dashboard.users.bulkAccess.description')}</MessageBarBody></MessageBar>
    <BulkUpstreamAccessControl
      available={upstreams}
      disabled={saving}
      models={models}
      onChange={changeAccess}
      states={states}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </DialogShell>;
}
