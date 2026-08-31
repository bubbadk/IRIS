import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  parseSubtitles,
  reassembleSubtitles,
  createTranslationChunks,
  buildChunkTranslationPrompt,
  parseChunkTranslationResponse,
  type ParsedSubtitleFile,
  type TranslationOptions,
  type TranslationProgress,
} from '@iris/subtitles';
import {
  createModelProvider,
  loadProviderConfigs,
  missingProviderConnectionFields,
  subscribeProviderConfigs,
  type ModelMessage,
  type ProviderConfig,
} from '@iris/providers';
import { loadProviderSecrets } from './credentials';
import { selectableAgentModels } from './agentModelSelection';

const commonLanguages = [
  { code: 'da', label: 'Danish (Dansk)' },
  { code: 'en', label: 'English' },
  { code: 'sv', label: 'Swedish (Svenska)' },
  { code: 'no', label: 'Norwegian (Norsk)' },
  { code: 'de', label: 'German (Deutsch)' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'fr', label: 'French (Français)' },
];

const defaultModelsByKind: Record<string, string[]> = {
  anthropic: [
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.5-preview',
    'o3-mini',
    'o1',
    'gpt-4-turbo',
  ],
  google: [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ],
  openrouter: [
    'anthropic/claude-3.7-sonnet',
    'openai/gpt-4o',
    'google/gemini-2.0-flash-001',
    'deepseek/deepseek-chat',
    'meta-llama/llama-3.3-70b-instruct',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
  ],
  mistral: [
    'mistral-large-latest',
    'mistral-small-latest',
    'codestral-latest',
  ],
  ollama: [
    'llama3.3',
    'llama3.2',
    'mistral',
    'qwen2.5',
    'deepseek-r1',
  ],
};

export function SubtitlesState() {
  const [providers, setProviders] = useState<ProviderConfig[]>(() =>
    loadProviderConfigs().filter((p) => p.enabled),
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const initial = loadProviderConfigs().filter((p) => p.enabled);
    const preferred =
      initial.find((c) => c.id.includes('anthropic') || c.id.includes('gemini') || c.id.includes('openai') || c.id.includes('openrouter')) ??
      initial[0];
    return preferred ? preferred.id : '';
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const initial = loadProviderConfigs().filter((p) => p.enabled);
    const preferred =
      initial.find((c) => c.id.includes('anthropic') || c.id.includes('gemini') || c.id.includes('openai') || c.id.includes('openrouter')) ??
      initial[0];
    if (!preferred) return '';
    const models = selectableAgentModels(preferred);
    const defaults = defaultModelsByKind[preferred.catalogId || preferred.kind] ?? [];
    return preferred.model || models[0] || defaults[0] || '';
  });

  const [fileName, setFileName] = useState<string>('');
  const [parsedFile, setParsedFile] = useState<ParsedSubtitleFile | null>(null);
  const [translatedMap, setTranslatedMap] = useState<Map<number, string>>(new Map());

  const [targetLanguage, setTargetLanguage] = useState<string>('Danish (Dansk)');
  const [chunkSize, setChunkSize] = useState<number>(25);
  const [maxCharsPerLine, setMaxCharsPerLine] = useState<number>(40);
  const [customInstructions, setCustomInstructions] = useState<string>(
    'Natural colloquial phrasing. Avoid literal Anglicisms. Preserve slang, swear words and informal speech.',
  );
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);

  const [progress, setProgress] = useState<TranslationProgress>({
    status: 'idle',
    currentChunk: 0,
    totalChunks: 0,
    translatedCuesCount: 0,
    totalCuesCount: 0,
    percent: 0,
  });

  const [activeCueId, setActiveCueId] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const leftListRef = useRef<HTMLDivElement | null>(null);
  const rightListRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to provider config changes
  useEffect(() => {
    const refresh = () => {
      const fresh = loadProviderConfigs().filter((p) => p.enabled);
      setProviders(fresh);
      if (fresh.length > 0 && !selectedProviderId) {
        const preferred =
          fresh.find((c) => c.id.includes('anthropic') || c.id.includes('gemini') || c.id.includes('openai') || c.id.includes('openrouter')) ??
          fresh[0];
        setSelectedProviderId(preferred.id);
        const models = selectableAgentModels(preferred);
        const defaults = defaultModelsByKind[preferred.catalogId || preferred.kind] ?? [];
        setSelectedModel(preferred.model || models[0] || defaults[0] || '');
      }
    };
    refresh();
    const unsubscribe = subscribeProviderConfigs(refresh);
    return () => {
      unsubscribe();
    };
  }, [selectedProviderId]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId),
    [providers, selectedProviderId],
  );

  const availableModels = useMemo(() => {
    if (!selectedProvider) return [];
    const catalogKey = selectedProvider.catalogId || selectedProvider.kind;
    const defaults = defaultModelsByKind[catalogKey] ?? defaultModelsByKind[selectedProvider.kind] ?? [];
    const configured = selectableAgentModels(selectedProvider);
    const combined = [...new Set([...configured, ...defaults, selectedProvider.model].filter(Boolean))];
    return combined.length > 0 ? combined : ['gpt-4o', 'claude-3-7-sonnet', 'gemini-2.0-flash'];
  }, [selectedProvider]);

  function handleProviderChange(id: string) {
    setSelectedProviderId(id);
    setIsCustomModel(false);
    const prov = providers.find((p) => p.id === id);
    if (prov) {
      const models = selectableAgentModels(prov);
      const catalogKey = prov.catalogId || prov.kind;
      const defaults = defaultModelsByKind[catalogKey] ?? defaultModelsByKind[prov.kind] ?? [];
      const bestDefault = prov.model || models[0] || defaults[0] || '';
      setSelectedModel(bestDefault);
    }
  }

  function handleFileContent(name: string, content: string) {
    try {
      const parsed = parseSubtitles(content);
      if (parsed.cues.length === 0) {
        alert('No valid subtitle cues found in file.');
        return;
      }
      setFileName(name);
      setParsedFile(parsed);
      setTranslatedMap(new Map());
      setActiveCueId(null);
      setProgress({
        status: 'idle',
        currentChunk: 0,
        totalChunks: Math.ceil(parsed.cues.length / chunkSize),
        translatedCuesCount: 0,
        totalCuesCount: parsed.cues.length,
        percent: 0,
      });
    } catch (err) {
      alert(`Error loading subtitle file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      handleFileContent(file.name, content);
    };
    reader.readAsText(file);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      handleFileContent(file.name, content);
    };
    reader.readAsText(file);
  }

  // Scroll to active cue in both panes
  useEffect(() => {
    if (activeCueId === null) return;
    const leftElem = document.getElementById(`cue-orig-${activeCueId}`);
    const rightElem = document.getElementById(`cue-trans-${activeCueId}`);
    if (leftElem) {
      leftElem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (rightElem) {
      rightElem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeCueId]);

  async function startTranslation() {
    if (!parsedFile || parsedFile.cues.length === 0) return;
    if (!selectedProvider) {
      alert('Please configure and select a model provider first in Settings/Models.');
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const chunks = createTranslationChunks(parsedFile.cues, chunkSize, 3);
    const currentTranslated = new Map<number, string>(translatedMap);

    setProgress({
      status: 'translating',
      currentChunk: 0,
      totalChunks: chunks.length,
      translatedCuesCount: currentTranslated.size,
      totalCuesCount: parsedFile.cues.length,
      percent: Math.round((currentTranslated.size / parsedFile.cues.length) * 100),
    });

    try {
      const storedSecrets = await loadProviderSecrets(selectedProvider.id);
      const connected = {
        ...selectedProvider,
        connectionValues: {
          ...(storedSecrets ?? {}),
          ...(selectedProvider.connectionValues ?? {}),
          ...(selectedProvider.apiKey ? { apiKey: selectedProvider.apiKey } : {}),
        },
      };

      const missing = missingProviderConnectionFields({ ...connected, storedSecretFields: [] });
      if (missing.length) {
        throw new Error(
          `Provider connection requires ${missing.map((f) => f.label).join(' and ')}. Please check your Model settings.`,
        );
      }

      const providerInstance = createModelProvider(connected);
      const options: TranslationOptions = {
        targetLanguage,
        chunkSize,
        maxCharsPerLine,
        customInstructions,
      };

      const targetModel = (selectedModel || selectedProvider.model).trim();

      for (let i = 0; i < chunks.length; i++) {
        if (abortController.signal.aborted) break;

        const chunk = chunks[i];
        // Check how many cues in this chunk still need translation
        const remainingInChunk = chunk.cues.filter((c) => !currentTranslated.has(c.id));
        if (remainingInChunk.length === 0) continue;

        setActiveCueId(chunk.cues[0]?.id ?? null);
        setProgress((prev) => ({
          ...prev,
          status: 'translating',
          currentChunk: i + 1,
          totalChunks: chunks.length,
        }));

        let attempts = 0;
        let success = false;

        while (attempts < 2 && !success && !abortController.signal.aborted) {
          attempts++;
          try {
            const promptText = buildChunkTranslationPrompt(chunk, options);
            const messages: ModelMessage[] = [
              {
                role: 'system',
                content:
                  'You are an elite subtitle translator. You respond strictly with the requested JSON array without preamble or thinking.',
              },
              {
                role: 'user',
                content: promptText,
              },
            ];

            let responseText = '';
            for await (const chunkStream of providerInstance.stream(
              {
                model: targetModel,
                messages,
                temperature: 0.2,
              },
              abortController.signal,
            )) {
              responseText += chunkStream.text;
            }

            const expectedIds = chunk.cues.map((c) => c.id);
            const parsedChunkResults = parseChunkTranslationResponse(responseText, expectedIds);

            if (parsedChunkResults.size > 0) {
              for (const cue of chunk.cues) {
                const translatedText = parsedChunkResults.get(cue.id);
                if (translatedText) {
                  currentTranslated.set(cue.id, translatedText);
                } else if (!currentTranslated.has(cue.id) && attempts === 2) {
                  // Fallback to original text if missing after retries
                  currentTranslated.set(cue.id, cue.text);
                }
              }
              success = true;
            } else if (attempts === 2) {
              // Final fallback if model returned completely empty/unparseable response
              for (const cue of chunk.cues) {
                if (!currentTranslated.has(cue.id)) {
                  currentTranslated.set(cue.id, cue.text);
                }
              }
              success = true;
            }
          } catch (chunkErr) {
            if (abortController.signal.aborted) throw chunkErr;
            if (attempts >= 2) {
              // Gracefully continue with original text on network error after retry
              for (const cue of chunk.cues) {
                if (!currentTranslated.has(cue.id)) {
                  currentTranslated.set(cue.id, cue.text);
                }
              }
              success = true;
            } else {
              // Wait 1s before retry
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }

        setTranslatedMap(new Map(currentTranslated));
        setProgress({
          status: 'translating',
          currentChunk: i + 1,
          totalChunks: chunks.length,
          translatedCuesCount: currentTranslated.size,
          totalCuesCount: parsedFile.cues.length,
          percent: Math.round((currentTranslated.size / parsedFile.cues.length) * 100),
        });
      }

      if (!abortController.signal.aborted) {
        setActiveCueId(null);
        setProgress((prev) => ({
          ...prev,
          status: 'completed',
          percent: 100,
        }));
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        setProgress((prev) => ({ ...prev, status: 'paused' }));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setProgress((prev) => ({
          ...prev,
          status: 'failed',
          error: msg,
        }));
      }
    } finally {
      abortControllerRef.current = null;
    }
  }

  function pauseTranslation() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setProgress((prev) => ({ ...prev, status: 'paused' }));
    }
  }

  function handleDownload() {
    if (!parsedFile) return;
    const reassembled = reassembleSubtitles(parsedFile, translatedMap);
    const extension = parsedFile.format;
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const outName = `${baseName}_${targetLanguage.split(' ')[0].toLowerCase()}.${extension}`;

    const blob = new Blob([reassembled], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleCopy() {
    if (!parsedFile) return;
    const reassembled = reassembleSubtitles(parsedFile, translatedMap);
    void navigator.clipboard.writeText(reassembled);
  }

  function handleReset() {
    if (progress.status === 'translating') {
      pauseTranslation();
    }
    setParsedFile(null);
    setFileName('');
    setTranslatedMap(new Map());
    setActiveCueId(null);
    setProgress({
      status: 'idle',
      currentChunk: 0,
      totalChunks: 0,
      translatedCuesCount: 0,
      totalCuesCount: 0,
      percent: 0,
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px 24px', gap: 16 }}>
      {/* Studio Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '1.25rem', opacity: 0.9 }}>💬</span>
            <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 680, letterSpacing: '-0.01em', color: 'var(--ink)' }}>
              Subtitle Studio
            </h2>
            {parsedFile && (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: '12px',
                  background: 'rgba(113, 133, 120, 0.12)',
                  color: '#4f6355',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {parsedFile.format} · {parsedFile.cues.length} cues
              </span>
            )}
          </div>
          <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: 'var(--muted)' }}>
            Intelligent chunked dialogue translation with zero timestamp drift.
          </p>
        </div>

        {parsedFile && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="soft-button"
              onClick={handleReset}
              style={{
                borderRadius: '20px',
                padding: '6px 14px',
                fontSize: '12px',
                border: '1px solid var(--line)',
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
            {translatedMap.size > 0 && (
              <>
                <button
                  type="button"
                  className="soft-button"
                  onClick={handleCopy}
                  title="Copy translated subtitle text to clipboard"
                  style={{
                    borderRadius: '20px',
                    padding: '6px 14px',
                    fontSize: '12px',
                    border: '1px solid var(--line)',
                    cursor: 'pointer',
                  }}
                >
                  Copy Text
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleDownload}
                  style={{
                    borderRadius: '20px',
                    padding: '6px 16px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxShadow: '0 2px 8px rgba(113, 133, 120, 0.25)',
                  }}
                >
                  Download .{parsedFile.format}
                </button>
              </>
            )}
          </div>
        )}
      </header>

      {/* Main Studio Area */}
      {!parsedFile ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            flex: 1,
            border: `1.5px dashed ${isDragging ? '#718578' : 'var(--line)'}`,
            borderRadius: '18px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
            textAlign: 'center',
            backgroundColor: isDragging ? 'rgba(113, 133, 120, 0.06)' : 'rgba(255, 254, 250, 0.5)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".srt,.vtt,text/plain"
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
          />
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'rgba(113, 133, 120, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
              marginBottom: 14,
            }}
          >
            🎬
          </div>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', fontWeight: 650, color: 'var(--ink)' }}>
            Drop subtitle file here
          </h3>
          <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: 'var(--muted)', maxWidth: 320 }}>
            Supports standard <strong>.SRT</strong> and WebVTT (<strong>.VTT</strong>) subtitle files.
          </p>
          <button
            type="button"
            className="primary-button"
            style={{
              padding: '8px 20px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            Select from Device
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 14, minHeight: 0 }}>
          {/* Controls Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
              padding: '12px 18px',
              borderRadius: '16px',
              backgroundColor: 'rgba(250, 248, 243, 0.85)',
              border: '1px solid var(--line)',
              boxShadow: '0 2px 10px rgba(70, 63, 48, 0.04)',
            }}
          >
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
              {/* Target Language */}
              <div style={{ minWidth: 140 }}>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
                  Language
                </label>
                <select
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value)}
                  disabled={progress.status === 'translating'}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    fontSize: '12px',
                    color: 'var(--ink)',
                  }}
                >
                  {commonLanguages.map((lang) => (
                    <option key={lang.code} value={lang.label}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Provider */}
              <div style={{ minWidth: 150 }}>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
                  Provider
                </label>
                <select
                  value={selectedProviderId}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={progress.status === 'translating'}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    fontSize: '12px',
                    color: 'var(--ink)',
                  }}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
              </div>

              {/* Model */}
              <div style={{ minWidth: 180, flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
                    Model
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsCustomModel((v) => !v)}
                    style={{ background: 'none', border: 'none', padding: 0, fontSize: '10px', color: '#4f6355', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    {isCustomModel ? 'Pick from list' : 'Type custom…'}
                  </button>
                </div>
                {isCustomModel ? (
                  <input
                    type="text"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={progress.status === 'translating'}
                    placeholder="e.g. gpt-4o, claude-3-7-sonnet..."
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--line)',
                      background: 'var(--surface)',
                      fontSize: '12px',
                      color: 'var(--ink)',
                    }}
                  />
                ) : (
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={progress.status === 'translating'}
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--line)',
                      background: 'var(--surface)',
                      fontSize: '12px',
                      color: 'var(--ink)',
                    }}
                  >
                    {availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Batch Size */}
              <div style={{ minWidth: 120 }}>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
                  Batch Size
                </label>
                <select
                  value={chunkSize}
                  onChange={(e) => setChunkSize(Number(e.target.value))}
                  disabled={progress.status === 'translating'}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    fontSize: '12px',
                    color: 'var(--ink)',
                  }}
                >
                  <option value={15}>15 cues</option>
                  <option value={25}>25 cues</option>
                  <option value={40}>40 cues</option>
                </select>
              </div>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="soft-button"
                onClick={() => setShowAdvanced((v) => !v)}
                title="Toggle advanced phrasing rules and character limits"
                style={{
                  padding: '7px 12px',
                  borderRadius: '20px',
                  border: '1px solid var(--line)',
                  fontSize: '11px',
                  cursor: 'pointer',
                  background: showAdvanced ? 'rgba(113, 133, 120, 0.15)' : 'transparent',
                }}
              >
                ⚙ Options
              </button>

              {progress.status === 'translating' ? (
                <button
                  type="button"
                  onClick={pauseTranslation}
                  style={{
                    padding: '7px 18px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    fontWeight: 650,
                    cursor: 'pointer',
                    background: '#e05353',
                    color: '#fff',
                    border: 'none',
                    boxShadow: '0 2px 8px rgba(224, 83, 83, 0.3)',
                  }}
                >
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  onClick={startTranslation}
                  style={{
                    padding: '7px 20px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    fontWeight: 650,
                    cursor: 'pointer',
                    boxShadow: '0 2px 10px rgba(113, 133, 120, 0.3)',
                  }}
                >
                  {translatedMap.size > 0 && translatedMap.size < parsedFile.cues.length
                    ? `Resume (${translatedMap.size}/${parsedFile.cues.length})`
                    : 'Start Translation'}
                </button>
              )}
            </div>
          </div>

          {/* Advanced Drawer */}
          {showAdvanced && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr',
                gap: 14,
                padding: '12px 18px',
                borderRadius: '14px',
                backgroundColor: 'rgba(250, 248, 243, 0.6)',
                border: '1px solid var(--line)',
              }}
            >
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', color: 'var(--muted)' }}>
                  Max chars / line
                </label>
                <input
                  type="number"
                  min={25}
                  max={60}
                  value={maxCharsPerLine}
                  onChange={(e) => setMaxCharsPerLine(Number(e.target.value))}
                  disabled={progress.status === 'translating'}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    fontSize: '12px',
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', color: 'var(--muted)' }}>
                  Stylistic Guidelines & Tone
                </label>
                <input
                  type="text"
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  disabled={progress.status === 'translating'}
                  placeholder="e.g. preserve swearing, casual dialogue, keep idioms natural..."
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    fontSize: '12px',
                  }}
                />
              </div>
            </div>
          )}

          {/* Progress Stream */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--muted)' }}>
              <span style={{ fontWeight: 550, color: 'var(--ink)' }}>
                {fileName}
              </span>
              <span>
                {progress.status === 'translating' && (
                  <span style={{ color: '#4f6355', fontWeight: 600 }}>
                    Translating batch {progress.currentChunk} of {progress.totalChunks}…
                  </span>
                )}
                {progress.status === 'completed' && <span style={{ color: '#2e7d32', fontWeight: 650 }}>✓ Completed</span>}
                {progress.status === 'paused' && <span style={{ color: '#b45309', fontWeight: 600 }}>Paused</span>}
                {progress.status === 'failed' && <span style={{ color: '#c62828', fontWeight: 600 }}>Error: {progress.error}</span>}
                {' '}({progress.translatedCuesCount} / {parsedFile.cues.length} cues · {progress.percent}%)
              </span>
            </div>

            <div style={{ width: '100%', height: 5, borderRadius: 3, backgroundColor: 'rgba(58, 54, 46, 0.08)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${progress.percent}%`,
                  backgroundColor: progress.status === 'failed' ? '#e05353' : progress.status === 'completed' ? '#4f7d5c' : '#718578',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>

          {/* Dual-Pane Cue Stream */}
          <div
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 16,
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            {/* Left Column: Original */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderRadius: '16px',
                border: '1px solid var(--line)',
                overflow: 'hidden',
                backgroundColor: 'rgba(255, 254, 250, 0.7)',
                boxShadow: '0 2px 8px rgba(70, 63, 48, 0.03)',
              }}
            >
              <div
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--line)',
                  backgroundColor: 'rgba(250, 248, 243, 0.9)',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                }}
              >
                Original Source
              </div>
              <div ref={leftListRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {parsedFile.cues.map((cue) => {
                  const isCurrentBatch = activeCueId !== null && cue.id >= activeCueId && cue.id < activeCueId + chunkSize;
                  return (
                    <div
                      key={cue.id}
                      id={`cue-orig-${cue.id}`}
                      style={{
                        padding: '10px 14px',
                        borderRadius: '12px',
                        backgroundColor: isCurrentBatch ? 'rgba(113, 133, 120, 0.08)' : 'var(--surface)',
                        border: isCurrentBatch ? '1px solid #718578' : '1px solid var(--line)',
                        fontSize: '13px',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--muted)', marginBottom: 6 }}>
                        <span style={{ fontWeight: 650 }}>#{cue.id}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', opacity: 0.85 }}>{cue.startTime} ➔ {cue.endTime}</span>
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45, color: 'var(--ink)' }}>{cue.text}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Translated */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderRadius: '16px',
                border: '1px solid var(--line)',
                overflow: 'hidden',
                backgroundColor: 'rgba(255, 254, 250, 0.7)',
                boxShadow: '0 2px 8px rgba(70, 63, 48, 0.03)',
              }}
            >
              <div
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--line)',
                  backgroundColor: 'rgba(250, 248, 243, 0.9)',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  color: '#556b5c',
                  textTransform: 'uppercase',
                }}
              >
                Translated Subtitles ({targetLanguage.split(' ')[0]})
              </div>
              <div ref={rightListRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {parsedFile.cues.map((cue) => {
                  const isDone = translatedMap.has(cue.id);
                  const translatedText = translatedMap.get(cue.id);
                  const isCurrentBatch = activeCueId !== null && cue.id >= activeCueId && cue.id < activeCueId + chunkSize;
                  return (
                    <div
                      key={cue.id}
                      id={`cue-trans-${cue.id}`}
                      style={{
                        padding: '10px 14px',
                        borderRadius: '12px',
                        backgroundColor: isDone ? 'rgba(244, 248, 245, 0.95)' : isCurrentBatch ? 'rgba(113, 133, 120, 0.08)' : 'rgba(255, 254, 250, 0.5)',
                        border: isDone ? '1px solid rgba(113, 133, 120, 0.3)' : isCurrentBatch ? '1px solid #718578' : '1px dashed var(--line)',
                        fontSize: '13px',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: isDone ? '#4f6355' : isCurrentBatch ? '#718578' : 'var(--muted)', marginBottom: 6 }}>
                        <span style={{ fontWeight: 650 }}>#{cue.id}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', opacity: 0.85 }}>{cue.startTime} ➔ {cue.endTime}</span>
                      </div>
                      <div
                        style={{
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.45,
                          color: isDone ? 'var(--ink)' : isCurrentBatch ? '#718578' : 'var(--muted)',
                          fontStyle: isDone ? 'normal' : 'italic',
                        }}
                      >
                        {isDone ? translatedText : isCurrentBatch ? 'Translating this batch now…' : 'Awaiting batch translation…'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
