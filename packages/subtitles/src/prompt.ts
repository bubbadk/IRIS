import type { TranslationChunk, TranslationOptions } from './types';

export function buildChunkTranslationPrompt(
  chunk: TranslationChunk,
  options: TranslationOptions,
): string {
  const targetLanguage = options.targetLanguage || 'Dansk (Danish)';
  const maxChars = options.maxCharsPerLine || 40;
  const custom = options.customInstructions ? `\nEkstra retningslinjer:\n${options.customInstructions}\n` : '';

  let contextSection = '';
  if (chunk.contextCues.length > 0) {
    contextSection = `
FORRIGE DIALOG-KONTEKST (KUN TIL LÆSNING - OVERSÆT IKKE DISSE IGEN):
${JSON.stringify(
  chunk.contextCues.map((c) => ({ id: c.id, text: c.text })),
  null,
  2,
)}
`;
  }

  const cuesToTranslate = chunk.cues.map((c) => ({ id: c.id, text: c.text }));

  return `Du er en professionel undertekstoversætter. 
Oversæt følgende undertekstblokke til naturligt, mundret ${targetLanguage}.

REGLER FOR UNDERTEKSTER:
1. Oversæt talesprog og idiomer naturligt til målsproget. Undgå stive, ordrette oversættelser (anglicismer).
2. Maksimalt ~${maxChars} tegn pr. linje og maksimalt 2 linjer pr. undertekstblok.
3. Bevar formateringstags som <i>...</i>, <b>...</b> eller <u>...</u> intakt.
4. Hver undertekst SKAL beholde sit oprindelige ID.${custom}
${contextSection}
UNDERTEKSTER DER SKAL OVERSÆTTES (Chunk ${chunk.chunkIndex} af ${chunk.totalChunks}):
${JSON.stringify(cuesToTranslate, null, 2)}

OUTPUT FORMAT:
Returnér KUN et gyldigt JSON array i dette nøjagtige format uden yderligere forklaring:
[
  { "id": ${chunk.cues[0]?.id ?? 1}, "text": "oversat tekst" }
]`;
}

export function parseChunkTranslationResponse(
  rawResponse: string,
  expectedIds?: number[],
): Map<number, string> {
  const resultMap = new Map<number, string>();
  const expectedSet = expectedIds ? new Set(expectedIds) : null;
  const text = rawResponse.trim();

  // Look for JSON block in markdown code fences or plain array
  let jsonString = text;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonString = codeBlockMatch[1].trim();
  } else {
    const arrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
      jsonString = arrayMatch[0].trim();
    }
  }

  try {
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object' && typeof item.id === 'number' && typeof item.text === 'string') {
          if (!expectedSet || expectedSet.has(item.id)) {
            resultMap.set(item.id, item.text);
          }
        } else if (item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string') {
          const numId = parseInt(item.id, 10);
          if (!isNaN(numId) && (!expectedSet || expectedSet.has(numId))) {
            resultMap.set(numId, item.text);
          }
        }
      }
    }
  } catch {
    // If JSON parse fails, attempt line-by-line heuristic parsing of [{"id": 1, "text": "..."}]
    const itemRegex = /"id"\s*:\s*(\d+)[\s\S]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(jsonString)) !== null) {
      const id = parseInt(match[1], 10);
      const val = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      if (!expectedSet || expectedSet.has(id)) {
        resultMap.set(id, val);
      }
    }
  }

  return resultMap;
}
