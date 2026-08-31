import type { TranslationChunk, TranslationOptions } from './types';

export function buildChunkTranslationPrompt(
  chunk: TranslationChunk,
  options: TranslationOptions,
): string {
  const targetLanguage = options.targetLanguage || 'Danish (Dansk)';
  const maxChars = options.maxCharsPerLine || 40;
  const custom = options.customInstructions ? `\nAdditional Style Instructions:\n${options.customInstructions}\n` : '';

  let contextSection = '';
  if (chunk.contextCues.length > 0) {
    contextSection = `
PRECEDING DIALOGUE CONTEXT (FOR CONTEXT ONLY - DO NOT RE-TRANSLATE THESE):
${JSON.stringify(
  chunk.contextCues.map((c) => ({ id: c.id, text: c.text })),
  null,
  2,
)}
`;
  }

  const cuesToTranslate = chunk.cues.map((c) => ({ id: c.id, text: c.text }));

  return `You are a world-class professional subtitle translator.
Translate the following subtitle dialogue cues accurately and colloquially into ${targetLanguage}.

SUBTITLE RULES:
1. Translate spoken dialogue naturally and colloquially into the target language. Preserve humor, idioms, tone, swearing, and informal phrasing. Avoid stiff literal translations.
2. Maintain max ~${maxChars} characters per line and max 2 lines per subtitle cue where possible.
3. Keep HTML formatting tags intact (e.g., <i>...</i>, <b>...</b>, <u>...</u>).
4. Every cue MUST retain its exact original integer "id".${custom}
${contextSection}
CUES TO TRANSLATE (Batch ${chunk.chunkIndex} of ${chunk.totalChunks}):
${JSON.stringify(cuesToTranslate, null, 2)}

OUTPUT FORMAT:
Return ONLY a valid JSON array of objects. Do not include markdown preamble, explanations, or thinking.
[
  { "id": ${chunk.cues[0]?.id ?? 1}, "text": "translated dialogue" }
]`;
}

export function parseChunkTranslationResponse(
  rawResponse: string,
  expectedIds?: number[],
): Map<number, string> {
  const resultMap = new Map<number, string>();
  const expectedSet = expectedIds ? new Set(expectedIds) : null;

  // 1. Strip reasoning / thinking tags (e.g. DeepSeek / Gemini thinking models)
  const text = rawResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Look for JSON markdown block or bracketed array
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

  // 3. Try standard JSON parse
  try {
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          const rawId = (item as { id?: unknown }).id;
          const rawText = (item as { text?: unknown }).text;
          const id = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10);
          const textVal = typeof rawText === 'string' ? rawText : String(rawText || '');
          if (!isNaN(id) && textVal && (!expectedSet || expectedSet.has(id))) {
            resultMap.set(id, textVal);
          }
        }
      }
    }
  } catch {
    // 4. Fallback regex extraction if JSON is slightly malformed
    const itemRegex = /"id"\s*:\s*(\d+)[\s\S]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(jsonString)) !== null) {
      const id = parseInt(match[1], 10);
      const val = match[2]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      if (!isNaN(id) && (!expectedSet || expectedSet.has(id))) {
        resultMap.set(id, val);
      }
    }
  }

  return resultMap;
}
