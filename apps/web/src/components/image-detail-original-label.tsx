import { Trans } from '../i18n/translation';

type ImageDetailOriginalKey =
  | 'dashboard.modelAliases.metadata.imageDetailOriginal'
  | 'dashboard.upstreamEditor.models.imageDetailOriginal';

export function ImageDetailOriginalLabel({ i18nKey }: { i18nKey: ImageDetailOriginalKey }) {
  return <Trans components={{ original: <code /> }} i18nKey={i18nKey} />;
}
