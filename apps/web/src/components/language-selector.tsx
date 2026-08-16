import { fluentComponents } from '../fluent';
import { setLanguage } from '../i18n';
import { storeLanguage } from '../i18n/language-preference';
import { defaultLanguage, normalizeLanguage, supportedLanguages, type SupportedLanguage } from '../i18n/languages';
import { useTranslation } from '../i18n/translation';
import { Dropdown } from './ui/fluent-form-controls';

const { Option } = fluentComponents;

// The languages are named in themselves, the way a native reader knows them; a
// translated label would tell a reader about their own language in someone
// else's. The control's accessible name is the one translated string here.
const languageNames: Record<SupportedLanguage, string> = {
  'en': 'English',
  'zh-Hans': '简体中文',
};

export function LanguageSelector({ className }: { className?: string }) {
  const { i18n, t } = useTranslation();
  const currentLanguage = normalizeLanguage(i18n.language) ?? defaultLanguage;

  const selectLanguage = (next: SupportedLanguage) => {
    void setLanguage(next)
      .then(() => storeLanguage(next))
      .catch(() => undefined);
  };

  return (
    <Dropdown
      aria-label={t('common.language')}
      className={className}
      onOptionSelect={(_, data) => {
        const next = normalizeLanguage(data.optionValue);
        if (next) selectLanguage(next);
      }}
      selectedOptions={[currentLanguage]}
      value={languageNames[currentLanguage]}
    >
      {supportedLanguages.map(language => (
        <Option key={language} value={language}>
          {languageNames[language]}
        </Option>
      ))}
    </Dropdown>
  );
}
