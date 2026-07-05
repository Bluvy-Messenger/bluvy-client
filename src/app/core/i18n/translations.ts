import { fr } from './locales/fr';
import { en } from './locales/en';

type TranslationDict = Record<string, string>;
type Translations = { fr: TranslationDict; en: TranslationDict };

export const TRANSLATIONS: Translations = { fr, en };
