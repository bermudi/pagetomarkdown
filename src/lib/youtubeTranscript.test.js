import { describe, it, expect, vi } from 'vitest';
import { pickBestTrack } from './youtubeTranscript.js';

// Mock browser for the module's import side-effect (updateYtDebug uses it)
// The module already imports webextension-polyfill, so we mock it before any test runs
vi.mock('webextension-polyfill', () => ({
  default: {
    storage: { local: { get: async () => ({ debugLogging: false }) } },
  },
}));

describe('pickBestTrack', () => {
  const tracks = [
    { languageCode: 'en', kind: '', baseUrl: 'https://example.com/en' },
    { languageCode: 'en', kind: 'asr', baseUrl: 'https://example.com/en-asr' },
    { languageCode: 'de', kind: '', baseUrl: 'https://example.com/de' },
    { languageCode: 'fr', kind: '', baseUrl: 'https://example.com/fr' },
  ];

  it('prefers manual English over auto English', () => {
    const best = pickBestTrack(tracks);
    expect(best.languageCode).toBe('en');
    expect(best.kind).toBe('');
  });

  it('falls back to auto English if manual missing', () => {
    const onlyAuto = [
      { languageCode: 'en', kind: 'asr', baseUrl: 'x' },
      { languageCode: 'de', kind: '', baseUrl: 'y' },
    ];
    const best = pickBestTrack(onlyAuto);
    expect(best.languageCode).toBe('en');
    expect(best.kind).toBe('asr');
  });

  it('uses LANG_FALLBACK_CHAIN when no English', () => {
    const noEn = [
      { languageCode: 'fr', kind: '', baseUrl: 'fr' },
      { languageCode: 'de', kind: '', baseUrl: 'de' },
      { languageCode: 'ja', kind: '', baseUrl: 'ja' },
    ];
    const best = pickBestTrack(noEn);
    // fallback chain is en, de, fr... so de should be picked before fr
    expect(best.languageCode).toBe('de');
  });

  it('returns first track if none in fallback chain', () => {
    const unknown = [
      { languageCode: 'xx', kind: '', baseUrl: 'xx' },
      { languageCode: 'yy', kind: '', baseUrl: 'yy' },
    ];
    const best = pickBestTrack(unknown);
    expect(best.languageCode).toBe('xx');
  });

  it('handles two-letter fuzzy matching via fallback', () => {
    const tracksFuzzy = [
      { languageCode: 'en-US', kind: '', baseUrl: 'en-US' },
      { languageCode: 'de-DE', kind: '', baseUrl: 'de-DE' },
    ];
    const best = pickBestTrack(tracksFuzzy);
    // byTwo('en-US') === 'en', so manual en is found
    expect(best.languageCode).toBe('en-US');
  });

  it('returns null for empty', () => {
    expect(pickBestTrack([])).toBeNull();
    expect(pickBestTrack(null)).toBeNull();
  });
});
