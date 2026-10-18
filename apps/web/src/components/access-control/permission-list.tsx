import { Checkmark24Regular, Dismiss12Regular } from '@fluentui/react-icons';
import { Children } from 'react';
import type { ReactNode } from 'react';

import { PrincipalIdentity } from './principal';
import { scopeKey } from './scope';
import { ScopeExpression, type ScopeExpressionData } from './scope-expression';
import { ACCESS_PERMISSIONS, permissionState, permissionTone, permissionValueLabel } from './values';
import type { AccessRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Trans, useTranslation } from '../../i18n/translation';
import { useStatusHue } from '../ui/status-badge';
import type { AccessPermission, AccessValues, PermissionDecisions } from '@floway-dev/gateway/browser';

const { Tag, Tooltip, makeStyles, mergeClasses, tokens, webLightTheme } = fluentComponents;

// SVG path.getBBox() in Dismiss12Regular's native 12-unit viewBox supplies these
// bounds. At 12px, offset the canvas into this shared slot so labels align.
// https://unpkg.com/@fluentui/react-icons@2.0.334/lib/sizedIcons/chunk-28.js
const dismissBounds = { x: 2.005393, y: 1.95, width: 8.044606, height: 8.044607 };

const useStyles = makeStyles({
  explanation: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
    '& > *': { flexShrink: 0, maxWidth: '100%' },
  },
  location: {
    display: 'contents',
    '& > .floway-scope-expression': { display: 'contents' },
    '& > .floway-scope-expression > *': { flexShrink: 0, maxWidth: '100%' },
  },
  token: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: '8px',
    paddingLeft: '8px',
    paddingRight: '8px',
    '& .fui-Tag__icon': { display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0, margin: 0 },
    '& .fui-Tag__primaryText': { paddingLeft: 0, paddingRight: 0 },
  },
});

interface PermissionContext { record: AccessRecord; data: ScopeExpressionData; decisions: PermissionDecisions }

function ExplanationRun({ children, location = false }: { children?: ReactNode; location?: boolean }) {
  const styles = useStyles();
  return <span className={location ? styles.location : styles.explanation} data-override-explanation={location ? undefined : ''} data-override-location={location ? '' : undefined}>
    {Children.map(children, child => typeof child === 'string'
      ? child.trim() ? <span className="floway-control-label whitespace-nowrap">{child.trim()}</span> : null
      : child)}
  </span>;
}

export function RulePermissions({ context, values }: { context?: PermissionContext; values: AccessValues }) {
  return <ul className="m-0 p-0 list-none flex flex-wrap items-start gap-2 pt-[1px]" data-permissions="">
    {ACCESS_PERMISSIONS.flatMap(permission => {
      const value = values[permission];
      return value === undefined ? [] : [<li className="flex-none" key={permission}>
        <PresentedPermission context={context} permission={permission} value={value} />
      </li>];
    })}
  </ul>;
}

function PresentedPermission({ context, permission, value }: { context: PermissionContext | undefined; permission: AccessPermission; value: NonNullable<AccessValues[AccessPermission]> }) {
  const decision = context?.decisions[permission];
  const token = <PermissionToken emphasis={decision?.kind ?? 'normal'} permission={permission} value={value} />;
  if (!context || decision?.kind !== 'overridden') return token;
  const by = decision.by;
  return <Tooltip
    content={{
      style: {
        fontSize: tokens.fontSizeBase300,
        lineHeight: tokens.lineHeightBase300,
        maxWidth: 'min(1120px, calc(100vw - 32px))',
        width: 'max-content',
        whiteSpace: 'normal',
      },
      children: <Trans
        components={{
          sentence: <ExplanationRun />,
          location: <ExplanationRun location />,
          principal: <PrincipalIdentity data={context.data} principal={by.principal} />,
          rule: <PermissionToken emphasis="effective" permission={permission} value={by.values[permission]!} />,
          scope: <ScopeExpression data={context.data} readOnly value={by.scope} />,
        }}
        i18nKey={scopeKey(context.record.scope) === scopeKey(by.scope) ? 'dashboard.accessControl.overridden.sameScope' : 'dashboard.accessControl.overridden.otherScope'}
      />,
    }}
    relationship="description"
  ><span className="winui-focus-rect inline-flex" data-overridden-by={by.id} tabIndex={0}>{token}</span></Tooltip>;
}

function PermissionToken({ emphasis = 'normal', permission, value }: { emphasis?: 'normal' | 'effective' | 'overridden'; permission: AccessPermission; value: NonNullable<AccessValues[AccessPermission]> }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const state = permissionState(value);
  const hue = useStatusHue(permissionTone(value));
  const label = t(`dashboard.accessControl.columns.${permission}`);
  const content = state === 'models' || state === 'full'
    ? t('dashboard.accessControl.permissionWithLevel', { permission: label, level: permissionValueLabel(value, t) })
    : label;
  const Icon = state === 'off' ? Dismiss12Regular : Checkmark24Regular;
  const off = state === 'off';
  const iconSize = off ? 12 : 14;
  const iconScale = state === 'off' ? 1 : 1.05;
  return <Tag
    appearance="outline"
    className={mergeClasses('flex-none', hue.className, styles.token)}
    data-permission-emphasis={emphasis}
    data-permission-state={state}
    data-permission-token={permission}
    icon={{
      style: { position: 'relative', width: dismissBounds.width, height: dismissBounds.height },
      children: <Icon aria-hidden style={{ color: 'var(--floway-badge-label)', position: 'absolute', width: iconSize, height: iconSize, transform: off ? 'scale(1)' : `translate(-50%, -50%) scale(${iconScale})`, transformOrigin: 'center', ...(off ? { left: -dismissBounds.x, top: -dismissBounds.y } : { left: '50%', top: '50%' }) }} />,
    }}
    primaryText={{ className: 'whitespace-nowrap' }}
    shape="rounded"
    size="small"
    style={{
      ...hue.style,
      borderWidth: 0,
      borderColor: 'transparent',
      // Keep Fluent's 6px Large radius; our WinUI theme maps Large to 8px.
      // https://github.com/microsoft/fluentui/blob/3e77c7d37f628ab997da534ff1cdd8a71d583eda/packages/tokens/src/global/borderRadius.ts#L3-L9
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L4-L6
      borderRadius: webLightTheme.borderRadiusLarge,
      position: 'relative',
      ...(emphasis === 'overridden' ? { opacity: 0.5 } : {}),
    }}
  >{content}{state === 'on' || state === 'off' ? <span className="sr-only"> {permissionValueLabel(value, t)}</span> : null}
    {emphasis !== 'normal' && <span className="sr-only"> {t(emphasis === 'effective' ? 'dashboard.accessControl.effective.activeAssignment' : 'dashboard.accessControl.overridden.label')}</span>}
    {emphasis === 'overridden' && <span aria-hidden className="absolute inset-0 overflow-hidden pointer-events-none" data-permission-strike="" style={{ borderRadius: webLightTheme.borderRadiusLarge }}>
      <svg className="block w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        <line stroke="currentColor" strokeOpacity={0.6} style={{ strokeWidth: 'var(--strokeWidthThin)' }} vectorEffect="non-scaling-stroke" x1="0" x2="100" y1="0" y2="100" />
      </svg>
    </span>}
  </Tag>;
}
