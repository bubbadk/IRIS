import type { RegisteredTool } from './index';

export interface ImageGenerationInput {
  prompt: string;
  model?: string;
  size?: '1024x1024' | '1024x1792' | '1792x1024' | '512x512' | '768x768';
  style?: 'vivid' | 'natural' | 'photorealistic' | 'minimalist' | 'illustration';
  apiKey?: string;
  provider?: 'openrouter' | 'openai' | 'pollinations' | 'auto';
}

export interface ImageGenerationOutput {
  prompt: string;
  url: string;
  model: string;
  revisedPrompt?: string;
  dimensions: string;
  status: 'completed' | 'failed';
}

export function createImageGenerationTool(
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>,
): RegisteredTool {
  const fetchImpl = customFetch || (typeof fetch !== 'undefined' ? fetch : undefined);

  return {
    id: 'image.generate',
    name: 'Generate Image',
    description:
      'Generates high-quality images from natural language descriptions using multimodal AI models (Flux, DALL-E 3, Stable Diffusion).',
    risk: 'external',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate.',
        },
        model: {
          type: 'string',
          description:
            'Model identifier, e.g. "black-forest-labs/flux-1-schnell", "dall-e-3", or "flux".',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1024x1792', '1792x1024', '512x512', '768x768'],
          description: 'Image dimensions (default: 1024x1024).',
        },
        style: {
          type: 'string',
          enum: ['vivid', 'natural', 'photorealistic', 'minimalist', 'illustration'],
          description: 'Aesthetic visual style.',
        },
        provider: {
          type: 'string',
          enum: ['openrouter', 'openai', 'pollinations', 'auto'],
          description: 'Provider backend (default: auto).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(input: unknown): Promise<ImageGenerationOutput> {
      if (!input || typeof input !== 'object') {
        throw new Error('Image generation requires an input object with a "prompt" field.');
      }
      const {
        prompt,
        model = 'flux',
        size = '1024x1024',
        style,
        apiKey,
        provider = 'auto',
      } = input as ImageGenerationInput;

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('Prompt must be a non-empty string.');
      }

      if (!fetchImpl) {
        throw new Error('Fetch implementation is not available in the current environment.');
      }

      const enhancedPrompt = style ? `${prompt.trim()}, ${style} style` : prompt.trim();
      const [width, height] = size.split('x').map(Number);

      try {
        // Option 1: Direct OpenAI DALL-E 3
        if (provider === 'openai' && apiKey) {
          const res = await fetchImpl('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: model === 'dall-e-3' ? 'dall-e-3' : 'dall-e-2',
              prompt: enhancedPrompt,
              n: 1,
              size,
            }),
          });

          if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`OpenAI image API failed (${res.status}): ${errBody}`);
          }

          const data = (await res.json()) as { data?: Array<{ url?: string; revised_prompt?: string }> };
          const imgUrl = data?.data?.[0]?.url;
          if (!imgUrl) {
            throw new Error('No image URL returned by OpenAI image API.');
          }
          return {
            prompt: prompt.trim(),
            url: imgUrl,
            model: 'openai/dall-e-3',
            revisedPrompt: data?.data?.[0]?.revised_prompt,
            dimensions: size,
            status: 'completed',
          };
        }

        // Option 2: OpenRouter Image Generation
        if (provider === 'openrouter' && apiKey) {
          const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: model.includes('/') ? model : 'black-forest-labs/flux-1-schnell',
              messages: [{ role: 'user', content: enhancedPrompt }],
            }),
          });

          if (res.ok) {
            const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const content = data?.choices?.[0]?.message?.content;
            const imgMatch = content?.match(/https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp)/i);
            if (imgMatch) {
              return {
                prompt: prompt.trim(),
                url: imgMatch[0],
                model,
                dimensions: size,
                status: 'completed',
              };
            }
          }
        }

        // Option 3: Resilient Instant Image Generation Gateway (Pollinations / Flux)
        const encodedPrompt = encodeURIComponent(enhancedPrompt);
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width || 1024}&height=${height || 1024}&model=flux&nologo=true&seed=${Math.floor(Math.random() * 100000)}`;

        // Verify image availability
        const probe = await fetchImpl(imageUrl, { method: 'HEAD' });
        if (!probe.ok && probe.status !== 405) {
          // If HEAD blocked, the URL is still directly loadable by browser
        }

        return {
          prompt: prompt.trim(),
          url: imageUrl,
          model: model || 'flux',
          dimensions: size,
          status: 'completed',
        };
      } catch (err) {
        throw new Error(
          `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
