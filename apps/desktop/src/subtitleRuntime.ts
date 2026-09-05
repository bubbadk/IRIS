import { SubtitleRuntime, emptySubtitleSession, type SubtitleSession, type TranslationSettings } from '@iris/subtitles';
import { createModelProvider, loadProviderConfigs, missingProviderConnectionFields } from '@iris/providers';
import { loadProviderSecrets } from './credentials';

const storageKey = 'iris.subtitles.session.v1';

function loadSession(): SubtitleSession | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const session = JSON.parse(raw) as SubtitleSession;
    if (session.version !== 1 || typeof session.fileName !== 'string' || !Array.isArray(session.translated) || !session.progress ||
      (session.parsedFile !== null && (!session.parsedFile || !Array.isArray(session.parsedFile.cues)))) {
      throw new Error('Invalid subtitle checkpoint');
    }
    return session;
  } catch (error) {
    return { ...emptySubtitleSession(), progress: { ...emptySubtitleSession().progress, status: 'failed', error: `Saved subtitle session could not be loaded: ${String(error)}.` } };
  }
}

export const subtitleRuntime = new SubtitleRuntime((session) => {
  if (typeof window !== 'undefined') localStorage.setItem(storageKey, JSON.stringify(session));
}, loadSession());

export async function startSubtitleTranslation(settings: TranslationSettings): Promise<void> {
  // Provider resolution belongs to the runtime adapter, independent of window lifetime.
  let provider: ReturnType<typeof createModelProvider> | undefined;
  return subtitleRuntime.start(settings, async (prompt, signal) => {
    if (!provider) {
      const config = loadProviderConfigs().find((item) => item.enabled && item.id === settings.providerId);
      if (!config) throw new Error('The selected subtitle provider is unavailable.');
      const secrets = await loadProviderSecrets(config.id);
      const connected = { ...config, connectionValues: { ...secrets, ...config.connectionValues, ...(config.apiKey ? { apiKey: config.apiKey } : {}) } };
      const missing = missingProviderConnectionFields({ ...connected, storedSecretFields: [] });
      if (missing.length) throw new Error(`Provider connection requires ${missing.map((field) => field.label).join(' and ')}.`);
      provider = createModelProvider(connected);
    }
    let response = '';
    for await (const chunk of provider.stream({ model: settings.model, messages: [
      { role: 'system', content: 'Translate subtitles. Return only the requested JSON array.' },
      { role: 'user', content: prompt },
    ], temperature: 0.2 }, signal)) response += chunk.text;
    return response;
  });
}
