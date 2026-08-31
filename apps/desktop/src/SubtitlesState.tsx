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
  { code: 'da', label: 'Dansk (Danish)' },
  { code: 'en', label: 'Engelsk (English)' },
  { code: 'sv', label: 'Svensk (Swedish)' },
  { code: 'no', label: 'Norsk (Norwegian)' },
  { code: 'de', label: 'Tysk (German)' },
  { code: 'es', label: 'Spansk (Spanish)' },
  { code: 'fr', label: 'Fransk (French)' },
];

export function SubtitlesState() {
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviderConfigs());
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const initial = loadProviderConfigs();
    const preferred =
      initial.find((c) => c.id.includes('anthropic') || c.id.includes('gemini') || c.id.includes('openai')) ??
      initial[0];
    return preferred ? preferred.id : '';
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const initial = loadProviderConfigs();
    const preferred =
      initial.find((c) => c.id.includes('anthropic') || c.id.includes('gemini') || c.id.includes('openai')) ??
      initial[0];
    if (!preferred) return '';
    const models = selectableAgentModels(preferred);
    return preferred.model || models[0] || '';
  });

  const [fileName, setFileName] = useState<string>('');
  const [parsedFile, setParsedFile] = useState<ParsedSubtitleFile | null>(null);
  const [translatedMap, setTranslatedMap] = useState<Map<number, string>>(new Map());

  const [targetLanguage, setTargetLanguage] = useState<string>('Dansk (Danish)');
  const [chunkSize, setChunkSize] = useState<number>(25);
  const [maxCharsPerLine, setMaxCharsPerLine] = useState<number>(40);
  const [customInstructions, setCustomInstructions] = useState<string>(
    'Mundret dansk talesprog. Undgå anglicismer og stive ordrette vendinger. Bevar slang og bandeord.',
  );
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);

  const [progress, setProgress] = useState<TranslationProgress>({
    status: 'idle',
    currentChunk: 0,
    totalChunks: 0,
    translatedCuesCount: 0,
    totalCuesCount: 0,
    percent: 0,
  });

  const [isDragging, setIsDragging] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Subscribe to provider config changes
  useEffect(() => {
    const refresh = () => {
      const fresh = loadProviderConfigs();
      setProviders(fresh);
      if (fresh.length > 0 && !selectedProviderId) {
        const preferred =
          fresh.find((c) => c.id.includes('anthropic') || c.id.includes('gemini') || c.id.includes('openai')) ??
          fresh[0];
        setSelectedProviderId(preferred.id);
        const models = selectableAgentModels(preferred);
        setSelectedModel(preferred.model || models[0] || '');
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

  const availableModels = useMemo(
    () => (selectedProvider ? selectableAgentModels(selectedProvider) : []),
    [selectedProvider],
  );

  function handleProviderChange(id: string) {
    setSelectedProviderId(id);
    const prov = providers.find((p) => p.id === id);
    if (prov) {
      const models = selectableAgentModels(prov);
      setSelectedModel(prov.model || models[0] || '');
    }
  }

  function handleFileContent(name: string, content: string) {
    try {
      const parsed = parseSubtitles(content);
      if (parsed.cues.length === 0) {
        alert('Ingen gyldige undertekster fundet i filen.');
        return;
      }
      setFileName(name);
      setParsedFile(parsed);
      setTranslatedMap(new Map());
      setProgress({
        status: 'idle',
        currentChunk: 0,
        totalChunks: Math.ceil(parsed.cues.length / chunkSize),
        translatedCuesCount: 0,
        totalCuesCount: parsed.cues.length,
        percent: 0,
      });
    } catch (err) {
      alert(`Fejl ved indlæsning af undertekstfil: ${err instanceof Error ? err.message : String(err)}`);
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

  async function startTranslation() {
    if (!parsedFile || parsedFile.cues.length === 0) return;
    if (!selectedProvider) {
      alert('Vælg venligst en model provider under Indstillinger/Modeller.');
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
          `Modellen mangler konfiguration for ${missing.map((f) => f.label).join(' og ')}. Tjek venligst dine Model Connections.`,
        );
      }

      const providerInstance = createModelProvider(connected);
      const options: TranslationOptions = {
        targetLanguage,
        chunkSize,
        maxCharsPerLine,
        customInstructions,
      };

      for (let i = 0; i < chunks.length; i++) {
        if (abortController.signal.aborted) break;

        const chunk = chunks[i];
        // Skip chunk if all its cues are already translated
        const alreadyDone = chunk.cues.every((cue) => currentTranslated.has(cue.id));
        if (alreadyDone) continue;

        setProgress((prev) => ({
          ...prev,
          status: 'translating',
          currentChunk: i + 1,
          totalChunks: chunks.length,
        }));

        const promptText = buildChunkTranslationPrompt(chunk, options);
        const messages: ModelMessage[] = [
          {
            role: 'system',
            content:
              'Du er en elite professionel undertekstoversætter. Du svarer udelukkende med det anmodede JSON format.',
          },
          {
            role: 'user',
            content: promptText,
          },
        ];

        let responseText = '';
        for await (const chunkStream of providerInstance.stream(
          {
            model: selectedModel || selectedProvider.model,
            messages,
            temperature: 0.2,
          },
          abortController.signal,
        )) {
          responseText += chunkStream.text;
        }

        const expectedIds = chunk.cues.map((c) => c.id);
        const parsedChunkResults = parseChunkTranslationResponse(responseText, expectedIds);

        for (const cue of chunk.cues) {
          const translatedText = parsedChunkResults.get(cue.id);
          if (translatedText) {
            currentTranslated.set(cue.id, translatedText);
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
    const outName = `${baseName}_dansk.${extension}`;

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
    alert('Den oversatte undertekstfil er kopieret til udklipsholderen!');
  }

  function handleReset() {
    if (progress.status === 'translating') {
      pauseTranslation();
    }
    setParsedFile(null);
    setFileName('');
    setTranslatedMap(new Map());
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
    <div className="subtitles-studio" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 14, padding: 18 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.08))', paddingBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1.4rem' }}>💬</span> Subtitle Studio
          </h2>
          <p style={{ margin: '3px 0 0 0', fontSize: '0.85rem', color: 'var(--text-muted, #737373)' }}>
            Intelligent chunk-baseret undertekstoversættelse med bevarelse af originale tidskoder.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {parsedFile && (
            <>
              <button
                className="ghost-button"
                onClick={handleReset}
                title="Ryd og vælg en ny fil"
                style={{ padding: '6px 12px', fontSize: '0.85rem', borderRadius: 6, cursor: 'pointer' }}
              >
                ↺ Nulstil
              </button>
              {translatedMap.size > 0 && (
                <>
                  <button
                    className="ghost-button"
                    onClick={handleCopy}
                    style={{ padding: '6px 12px', fontSize: '0.85rem', borderRadius: 6, cursor: 'pointer' }}
                  >
                    📋 Kopiér
                  </button>
                  <button
                    className="primary-button"
                    onClick={handleDownload}
                    style={{ padding: '6px 14px', fontSize: '0.85rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                  >
                    📥 Download .{parsedFile.format}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      {!parsedFile ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            flex: 1,
            border: `2px dashed ${isDragging ? 'var(--accent, #3b82f6)' : 'var(--border-subtle, #d1d5db)'}`,
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 36,
            textAlign: 'center',
            backgroundColor: isDragging ? 'rgba(59, 130, 246, 0.04)' : 'transparent',
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
          <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🎬</div>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '1.1rem' }}>Træk en undertekstfil hertil</h3>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted, #737373)' }}>
            Understøtter <strong>.SRT</strong> og <strong>.VTT</strong> filer.
          </p>
          <button
            className="primary-button"
            style={{ marginTop: 18, padding: '8px 18px', borderRadius: 8, fontSize: '0.9rem', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            Vælg fil fra computer
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 12, minHeight: 0 }}>
          {/* Controls Bar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
              padding: 12,
              borderRadius: 8,
              backgroundColor: 'var(--surface-subtle, rgba(0,0,0,0.02))',
              border: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
            }}
          >
            {/* Target Language */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted, #737373)' }}>
                Målsprog
              </label>
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                disabled={progress.status === 'translating'}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', background: 'var(--bg, #fff)' }}
              >
                {commonLanguages.map((lang) => (
                  <option key={lang.code} value={lang.label}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Provider / Model */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted, #737373)' }}>
                Model
              </label>
              <div style={{ display: 'flex', gap: 4 }}>
                <select
                  value={selectedProviderId}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={progress.status === 'translating'}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', background: 'var(--bg, #fff)' }}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
                {availableModels.length > 1 && (
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={progress.status === 'translating'}
                    style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', background: 'var(--bg, #fff)' }}
                  >
                    {availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* Chunk Size */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted, #737373)' }}>
                Chunk Størrelse
              </label>
              <select
                value={chunkSize}
                onChange={(e) => setChunkSize(Number(e.target.value))}
                disabled={progress.status === 'translating'}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', background: 'var(--bg, #fff)' }}
              >
                <option value={15}>15 cues / chunk (Maksimal præcision)</option>
                <option value={25}>25 cues / chunk (Anbefalet)</option>
                <option value={40}>40 cues / chunk (Hurtigere)</option>
              </select>
            </div>

            {/* Action Trigger */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setShowAdvanced((v) => !v)}
                title="Vis/skjul avancerede retningslinjer og linjelængde"
                style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}
              >
                ⚙ {showAdvanced ? 'Mindre' : 'Avanceret'}
              </button>
              {progress.status === 'translating' ? (
                <button
                  className="ghost-button"
                  onClick={pauseTranslation}
                  style={{ flex: 1, padding: '7px 12px', borderRadius: 6, color: '#e11d48', borderColor: '#fecdd3', cursor: 'pointer', fontWeight: 600 }}
                >
                  ⏸ Pause Oversættelse
                </button>
              ) : (
                <button
                  className="primary-button"
                  onClick={startTranslation}
                  style={{ flex: 1, padding: '7px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                >
                  {translatedMap.size > 0 && translatedMap.size < parsedFile.cues.length
                    ? `Fortsæt (${translatedMap.size}/${parsedFile.cues.length})`
                    : '▶ Start Oversættelse'}
                </button>
              )}
            </div>
          </div>

          {/* Advanced Settings Drawer */}
          {showAdvanced && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr',
                gap: 12,
                padding: 12,
                borderRadius: 8,
                backgroundColor: 'var(--surface-subtle, rgba(0,0,0,0.02))',
                border: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
              }}
            >
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', color: 'var(--text-muted, #737373)' }}>
                  Maks tegn pr. linje
                </label>
                <input
                  type="number"
                  min={25}
                  max={60}
                  value={maxCharsPerLine}
                  onChange={(e) => setMaxCharsPerLine(Number(e.target.value))}
                  disabled={progress.status === 'translating'}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', background: 'var(--bg, #fff)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', color: 'var(--text-muted, #737373)' }}>
                  Ekstra instruktioner til oversætteren
                </label>
                <input
                  type="text"
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  disabled={progress.status === 'translating'}
                  placeholder="Fx bevar bandeord, uformelt talesprog..."
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', background: 'var(--bg, #fff)' }}
                />
              </div>
            </div>
          )}

          {/* Progress Banner */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
              <span>
                <strong>{fileName}</strong> ({parsedFile.cues.length} undertekster) · Format: <strong>{parsedFile.format.toUpperCase()}</strong>
              </span>
              <span>
                {progress.status === 'translating' && (
                  <span style={{ color: 'var(--accent, #3b82f6)' }}>
                    Oversætter chunk {progress.currentChunk} af {progress.totalChunks}…
                  </span>
                )}
                {progress.status === 'completed' && <span style={{ color: '#16a34a', fontWeight: 600 }}>✓ Færdigoversat</span>}
                {progress.status === 'paused' && <span style={{ color: '#d97706' }}>Pauset</span>}
                {progress.status === 'failed' && <span style={{ color: '#dc2626' }}>Fejl: {progress.error}</span>}
                {' '}({progress.translatedCuesCount} / {parsedFile.cues.length} linjer · {progress.percent}%)
              </span>
            </div>

            <div style={{ width: '100%', height: 6, borderRadius: 3, backgroundColor: 'var(--surface-subtle, #e5e7eb)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${progress.percent}%`,
                  backgroundColor: progress.status === 'failed' ? '#dc2626' : progress.status === 'completed' ? '#16a34a' : 'var(--accent, #3b82f6)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>

          {/* Dual-Pane View: Original vs Translated */}
          <div
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            {/* Left Pane: Original */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 8,
                border: '1px solid var(--border-subtle, rgba(0,0,0,0.08))',
                overflow: 'hidden',
                backgroundColor: 'var(--surface, #fff)',
              }}
            >
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.06))', backgroundColor: 'var(--surface-subtle, rgba(0,0,0,0.02))', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted, #737373)' }}>
                ORIGINAL KILDETEKST
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {parsedFile.cues.map((cue) => (
                  <div
                    key={cue.id}
                    style={{
                      padding: 8,
                      borderRadius: 6,
                      backgroundColor: translatedMap.has(cue.id) ? 'rgba(0,0,0,0.015)' : 'rgba(0,0,0,0.03)',
                      borderLeft: '3px solid #94a3b8',
                      fontSize: '0.875rem',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', marginBottom: 4, fontFamily: 'monospace' }}>
                      <span>#{cue.id}</span>
                      <span>{cue.startTime} ➔ {cue.endTime}</span>
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{cue.text}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right Pane: Translated */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 8,
                border: '1px solid var(--border-subtle, rgba(0,0,0,0.08))',
                overflow: 'hidden',
                backgroundColor: 'var(--surface, #fff)',
              }}
            >
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.06))', backgroundColor: 'var(--surface-subtle, rgba(0,0,0,0.02))', fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent, #3b82f6)' }}>
                OVERSAT TEKST ({targetLanguage})
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {parsedFile.cues.map((cue) => {
                  const isDone = translatedMap.has(cue.id);
                  const translatedText = translatedMap.get(cue.id);
                  return (
                    <div
                      key={cue.id}
                      style={{
                        padding: 8,
                        borderRadius: 6,
                        backgroundColor: isDone ? 'rgba(34, 197, 94, 0.05)' : 'rgba(0,0,0,0.01)',
                        borderLeft: `3px solid ${isDone ? '#22c55e' : '#e2e8f0'}`,
                        fontSize: '0.875rem',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: isDone ? '#16a34a' : '#94a3b8', marginBottom: 4, fontFamily: 'monospace' }}>
                        <span>#{cue.id}</span>
                        <span>{cue.startTime} ➔ {cue.endTime}</span>
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4, color: isDone ? 'inherit' : 'var(--text-muted, #94a3b8)', fontStyle: isDone ? 'normal' : 'italic' }}>
                        {isDone ? translatedText : 'Afventer oversættelse…'}
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
