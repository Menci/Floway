import { Trans, type TFunction } from '../../src/i18n/translation';

declare const t: TFunction;

t('common.cancel');
t('dashboard.searchConfig.unavailable', { id: 'provider-id' });
t('dashboard.proxy.form.timeoutPlaceholder', { seconds: 30 });
t('dashboard.models.badges.aliasOfCount', { count: 2 });

declare const dynamicKey: string;
t(dynamicKey, { upstreamValue: true });

declare const mixedInterpolationKey: 'common.cancel' | 'dashboard.apiKeys.configuration.usingKey';
t(mixedInterpolationKey, { name: 'key' });

// @ts-expect-error -- A string without placeholders does not accept a values object.
t('common.cancel', {});
// @ts-expect-error -- A bare placeholder requires its string value.
t('dashboard.searchConfig.unavailable');
// @ts-expect-error -- A bare placeholder cannot receive a number.
t('dashboard.searchConfig.unavailable', { id: 1 });
// @ts-expect-error -- A formatted placeholder requires its number value.
t('dashboard.proxy.form.timeoutPlaceholder');
// @ts-expect-error -- A numeric format cannot receive a string.
t('dashboard.proxy.form.timeoutPlaceholder', { seconds: '30' });
// @ts-expect-error -- A plural base requires the count that selects its form.
t('dashboard.models.badges.aliasOfCount');
// @ts-expect-error -- Plural selection requires a numeric count.
t('dashboard.models.badges.aliasOfCount', { count: '2' });
// @ts-expect-error -- A literal absent from the catalogue is a typo, not a dynamic key.
t('common.cacnel');
// @ts-expect-error -- Every member of a union must belong to the catalogue.
t('common.cancel' as 'common.cancel' | 'common.cacnel');
// @ts-expect-error -- Values must satisfy every possible member of a union key.
t(mixedInterpolationKey);

void <Trans i18nKey="dashboard.apiKeys.configuration.usingKey" values={{ name: 'key' }} />;
void <Trans count={2} i18nKey="dashboard.models.badges.aliasOfCount" />;

// @ts-expect-error -- Trans uses the same string interpolation contract as t.
void <Trans i18nKey="dashboard.apiKeys.configuration.usingKey" values={{ name: 1 }} />;
// @ts-expect-error -- A plural Trans requires the count that selects its form.
void <Trans i18nKey="dashboard.models.badges.aliasOfCount" />;
// @ts-expect-error -- Trans plural selection requires a numeric count.
void <Trans count="2" i18nKey="dashboard.models.badges.aliasOfCount" />;
// @ts-expect-error -- The count prop owns plural interpolation; values must not duplicate it.
void <Trans count={2} i18nKey="dashboard.models.badges.aliasOfCount" values={{ count: 2 }} />;
// @ts-expect-error -- Trans accepts catalogue keys only.
void <Trans i18nKey="common.cacnel" />;
