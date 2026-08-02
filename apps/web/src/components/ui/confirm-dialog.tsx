import { useTranslation } from 'react-i18next';

import { DialogShell } from './dialog-shell';
import { OutcomeMessageBar } from './outcome-message-bar';
import { fluentComponents } from '../../fluent';

const { Button, DialogActions, DialogTitle, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // A destructive confirmation is an accent button wearing Fluent's danger ramp,
  // one #c50f1f family in both themes. The label is StaticInverted, white in
  // both, because the fill does not follow the theme.
  //
  // Not OnBrand: ../../winui/theme.ts re-points it at WinUI's
  // TextOnAccentFillColorPrimary, which is keyed to the accent's own lightness
  // and so goes black in dark, reading 3.46:1 at rest and 2.36 pressed on a fill
  // that stays dark red. Not DangerForegroundInverted either -- that is the
  // danger hue for use ON an inverted surface, and over DangerBackground3 it
  // reads 1.74:1 in light and 1.17:1 in dark.
  //
  // Every rule is qualified to the enabled states: the `!important` that lets
  // these outrank the WinUI layer's accent fill would otherwise also outrank the
  // disabled painting, which is the whole signal that the confirmation is in
  // flight. Pressed is `:active` alone because WinUI enters Pressed on a
  // keyboard invoke as well as under the pointer.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L106-L110
  //
  // Colour is confined to `@media not (forced-colors: active)`: WinUI maps the
  // whole AccentButton brush set onto system brushes there, so intent stops
  // being expressible and Fluent's Highlight/HighlightText drawing stands.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L53-L65
  danger: {
    '@media not (forced-colors: active)': {
      '&:not(:disabled):not([aria-disabled="true"])': {
        backgroundColor: 'var(--colorStatusDangerBackground3) !important',
        color: 'var(--colorNeutralForegroundStaticInverted) !important',
      },
      '&:not(:disabled):not([aria-disabled="true"]):hover': {
        backgroundColor: 'var(--colorStatusDangerBackground3Hover) !important',
      },
      '&:not(:disabled):not([aria-disabled="true"]):active': {
        backgroundColor: 'var(--colorStatusDangerBackground3Pressed) !important',
      },
    },
  },
});

export function ConfirmDialog({
  actionIntent = 'danger',
  actionLabel,
  busy = false,
  cancelLabel,
  error,
  message,
  onCancel,
  onConfirm,
  onDismissError,
  onExited,
  onOpenChange,
  open,
  title,
}: {
  actionIntent?: 'danger' | 'primary';
  actionLabel: string;
  busy?: boolean;
  cancelLabel?: string;
  /**
   * A failed attempt at the action, reported here rather than behind the dialog,
   * where a page-level report would sit under the dialog the operator is
   * looking at.
   */
  error?: string | null;
  message: string;
  onCancel?: () => void;
  onConfirm: () => void;
  onDismissError?: () => void;
  /** See DialogShell: the deed a confirmation does to its own tree goes here. */
  onExited?: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  const { t } = useTranslation();
  const styles = useStyles();

  return (
    <DialogShell
      open={open}
      onExited={onExited}
      actions={<DialogActions>
        <Button
          className="!whitespace-nowrap"
          disabled={busy}
          onClick={() => {
            if (onCancel) onCancel();
            else onOpenChange(false);
          }}
        >
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button
          appearance="primary"
          className={mergeClasses('!whitespace-nowrap', actionIntent === 'danger' && styles.danger)}
          disabledFocusable={busy}
          onClick={onConfirm}
        >
          {actionLabel}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => !busy && onOpenChange(data.open)}
      surfaceClassName="!w-[min(430px,calc(100vw-48px))]"
      title={<DialogTitle>{title}</DialogTitle>}
    >
      <div className="grid gap-3 min-w-0">
        <span>{message}</span>
        {error && <OutcomeMessageBar onDismiss={onDismissError}>{error}</OutcomeMessageBar>}
      </div>
    </DialogShell>
  );
}
