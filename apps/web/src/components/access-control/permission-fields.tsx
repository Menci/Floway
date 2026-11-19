import { BranchForkFilled, BranchForkRegular } from '@fluentui/react-icons';
import { useId } from 'react';
import type { ComponentProps, Ref } from 'react';

import { permissionState, permissionValueLabel } from './values';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import type { AccessPermission, AccessValues, UpstreamEditLevel } from '@floway-dev/gateway/browser';

const { Label, Radio, RadioGroup, Tooltip, makeStyles, tokens } = fluentComponents;
type Value = boolean | UpstreamEditLevel | undefined;
type Choice = 'on' | 'off' | 'models' | 'full';

const useStyles = makeStyles({
  // Shared column tracks align boolean and edit-level permission choices.
  grid: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)',
    columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalL, minWidth: 0,
    '@media (max-width: 680px)': { gridTemplateColumns: 'minmax(0, 1fr)', rowGap: tokens.spacingVerticalS },
  },
  choices: {
    '&.fui-RadioGroup.fui-RadioGroup': { display: 'grid', gap: 0, minWidth: 0 },
    '& .fui-Radio.fui-Radio': { minWidth: 0, margin: 0 },
    '& .fui-Radio__label': { minWidth: 0 },
  },
});

export function PermissionFields({ disabled, inherited, onChange, permissions, values }: {
  disabled: boolean;
  inherited?: AccessValues;
  onChange: (permission: AccessPermission, value: Value) => void;
  permissions: readonly AccessPermission[];
  values: AccessValues;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  return <fieldset className="m-0 p-0 border-0 min-w-0" data-permission-editor="radio">
    <legend className="p-0 mb-2 text-[14px] leading-5 font-normal">{t('dashboard.accessControl.fields.permissions')}</legend>
    <div className={styles.grid}>{permissions.map(permission => <PermissionField
      disabled={disabled} inherited={inherited?.[permission]} key={permission} levelColumns={permissions.includes('Upstream.Edit')}
      onChange={value => onChange(permission, value)} permission={permission} value={values[permission]}
    />)}</div>
  </fieldset>;
}

function PermissionField({ disabled, inherited, levelColumns, onChange, permission, value }: {
  disabled: boolean;
  inherited: Value;
  levelColumns: boolean;
  onChange: (value: Value) => void;
  permission: AccessPermission;
  value: Value;
}) {
  const { t } = useTranslation();
  const id = useId();
  const styles = useStyles();
  const inheriting = value === undefined;
  const inheritedChoice = inherited === undefined ? undefined : permissionState(inherited);
  const selected = inheriting ? inheritedChoice : permissionState(value);
  const choices: Choice[] = permission === 'Upstream.Edit' ? ['off', 'models', 'full'] : ['off', 'on'];
  const Marker = inheriting ? BranchForkFilled : BranchForkRegular;
  const sourceId = `${id}-source`;
  const inheritedId = `${id}-inherited`;
  const source = t(`dashboard.accessControl.inheritance.${inheriting ? 'currentlyInherited' : 'explicitAssignment'}`);
  const description = inherited === undefined ? null : t('dashboard.accessControl.inheritance.inheritedValue', { value: permissionValueLabel(inherited, t) });
  const choose = (choice: string) => {
    if (choice === 'on') onChange(true);
    else if (choice === 'off') onChange(permission === 'Upstream.Edit' ? 'off' : false);
    else if (choice === 'models' || choice === 'full') onChange(choice);
    else throw new Error(`Unknown permission choice: ${choice}`);
  };
  return <div className="contents" data-permission-field={permission} data-permission-source={inheriting ? 'inherited' : 'explicit'}>
    <div className="flex self-start items-center min-w-0 min-h-[34px]">
      <Label id={id} style={{ color: inheriting ? tokens.colorNeutralForeground2 : tokens.colorNeutralForeground1, fontWeight: inheriting ? tokens.fontWeightRegular : tokens.fontWeightMedium }}>{t(`dashboard.accessControl.permissions.${permission}`)}</Label>
      <span aria-live="polite" className="sr-only" id={sourceId}>{source}</span>
      {description !== null && <span className="sr-only" id={inheritedId}>{description}</span>}
    </div>
    <RadioGroup
      aria-describedby={sourceId} aria-labelledby={id} className={styles.choices} disabled={disabled} layout="horizontal"
      onChange={(_, option) => choose(option.value)}
      style={{ gridTemplateColumns: levelColumns ? 'minmax(0, 1fr) minmax(0, 1.6fr) minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))' }} value={selected ?? ''}
    >
      {choices.map(choice => {
        const radio = (root?: ComponentProps<typeof Radio>['root']) => <Radio
          input={{
            'aria-label': t(`dashboard.accessControl.states.${choice}`),
            'aria-describedby': choice === inheritedChoice ? `${sourceId} ${inheritedId}` : sourceId,
            // Handle Space before native activation so the source toggles once.
            onClick: () => { if (selected === choice) { if (inheriting) choose(choice); else onChange(undefined); } },
            onKeyDown: event => {
              if (event.key === ' ' && selected === choice) {
                event.preventDefault();
                if (inheriting) choose(choice); else onChange(undefined);
              }
            },
          }} key={choice} root={root} value={choice}
          label={<span className="inline-flex items-center gap-1 min-w-0">
            <span className="floway-control-label whitespace-nowrap">{t(`dashboard.accessControl.states.${choice}`)}</span>
            {choice === inheritedChoice && <span aria-hidden className="inline-flex flex-none" data-inherited-value-icon="branch" data-inheritance-active={inheriting} data-inheritance-glyph={inheriting ? 'filled' : 'regular'} style={{ color: inheriting ? tokens.colorBrandForeground1 : tokens.colorNeutralForeground2 }}><Marker style={{ width: 16, height: 16 }} /></span>}
          </span>}
        />;
        // Radio routes top-level trigger props to its input. Use the root slot
        // so Tooltip also covers the label and the full option surface.
        // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-radio/library/src/components/Radio/useRadio.tsx#L56-L83
        // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-radio/library/src/components/Radio/renderRadio.tsx#L14-L20
        return choice === inheritedChoice && description !== null ? <Tooltip content={t('dashboard.accessControl.inheritance.tooltip', { description, source })} key={choice} relationship="description">{triggerProps => radio({ ...triggerProps, ref: triggerProps.ref as Ref<HTMLSpanElement> })}</Tooltip> : radio();
      })}
      {inheriting && inheritedChoice === undefined && <span className="col-span-full text-[12px] leading-4 text-fui-fg2" data-inheritance-unknown="">{t('dashboard.accessControl.inheritance.unknown')}</span>}
    </RadioGroup>
  </div>;
}
