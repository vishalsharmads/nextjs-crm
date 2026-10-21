import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

/**
 * Copy lives in locale files. Entity names are never hardcoded: strings interpolate vocabulary
 * variables such as {{contact}}, {{contactPlural}}, {{contactLower}}, {{contactPluralLower}}.
 */
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
