import { assertNoCredentialArguments, type RegisteredTool } from './index';

export type ImageProviderId = 'openai' | 'openrouter' | 'pollinations';
export type ImageProviderSelection = ImageProviderId | 'auto';

export interface ImageGenerationInput {
  prompt: string;
  model?: string;
  size?: '1024x1024' | '1024x1792' | '1792x1024' | '512x512' | '768x768';
  style?: 'vivid' | 'natural' | 'photorealistic' | 'minimalist' | 'illustration';
  provider?: ImageProviderSelection;
}

export interface ImageGenerationOutput {
  prompt: string;
  url: string;
  /** The model that actually produced this image, never the requested placeholder. */
  model: string;
  dimensions: string;
  status: 'completed' | 'failed';
  /** Provider the caller asked for ('auto' when it did not name one). */
  requestedProvider: ImageProviderSelection;
  /** Model identifier the caller asked for (the raw requested value, including the default). */
  requestedModel: string;
  /** Provider that actually served the image. Always the provider named in `url`. */
  actualProvider: ImageProviderId;
  /** Model that actually served the image. */
  actualModel: string;
  /**
   * Origin that actually served this image. For keyed providers this is the endpoint of the trusted
   * provider configuration — the same origin the credential was sent to — so a successful result
   * cannot imply the first-party host while a custom gateway served it.
   */
  providerOrigin?: string;
  /**
   * True only when this result came from a provider other than the one that was requested. IRIS
   * never switches provider on its own, so this is always false today: it exists so a future
   * explicitly-approved fallback feature cannot quietly reintroduce silent substitution (M-32).
   */
  providerFallback: boolean;
  revisedPrompt?: string;
  /** Present when status is 'failed': why the gateway could not serve the image. */
  message?: string;
}

const ALLOWED_SIZES = ['1024x1024', '1024x1792', '1792x1024', '512x512', '768x768'] as const;

/**
 * One trusted provider configuration, bound to the credential that belongs to it.
 *
 * The endpoint and the credential are read from the *same* stored provider configuration, so a
 * credential can only ever be transmitted to the origin that configuration itself names. This type
 * is the security boundary for H1: there is deliberately no way to resolve a credential without
 * also resolving the destination it is authorized for.
 *
 * Every field is supplied by the trusted host layer. The model never supplies credentials or
 * endpoints: tool arguments are untrusted, so any `apiKey` field in them has no authority.
 */
export interface ImageProviderBinding {
  /** Identity of the stored provider configuration both `endpoint` and `apiKey` came from. */
  configurationId: string;
  /** IRIS image provider this configuration speaks for. */
  provider: 'openai' | 'openrouter';
  /** Base URL of that configuration. Image request URLs are built from this exact value. */
  endpoint: string;
  /** Credential resolved from the trusted store for that same configuration. */
  apiKey: string;
}

/**
 * Resolves the trusted binding for a named image provider from the provider configuration store and
 * the trusted credential store. Callers that provide no resolver can only use the keyless
 * Pollinations path.
 */
export type ImageProviderBindingResolver = (
  provider: 'openai' | 'openrouter',
) => Promise<ImageProviderBinding | undefined>;

/** Placeholder model name meaning "let the provider choose", not a real model identifier. */
const defaultModelPlaceholder = 'flux';

/**
 * IRIS's own first-party image endpoints. Used only to detect the M-32 shape of lie — a provider
 * handing back an asset served by a *different* provider — so the result cannot claim provider X
 * produced something provider Y serves.
 */
const knownImageProviderHosts: Readonly<Record<string, ImageProviderId>> = {
  'image.pollinations.ai': 'pollinations',
  'api.openai.com': 'openai',
  'openrouter.ai': 'openrouter',
};

/** The provider a returned image URL actually belongs to, when the host is a recognised one. */
export function imageProviderForUrl(url: string): ImageProviderId | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const exact = knownImageProviderHosts[host];
    if (exact) return exact;
    const suffixMatch = Object.entries(knownImageProviderHosts).find(([knownHost]) =>
      host.endsWith(`.${knownHost}`),
    );
    return suffixMatch?.[1];
  } catch {
    return undefined;
  }
}

/**
 * A keyed provider must not answer with another IRIS provider's asset. Returns the mismatched
 * provider when the trusted response path produced one, so the caller can fail truthfully instead of
 * relabelling the image.
 */
function mismatchedImageProvider(
  url: string,
  actualProvider: ImageProviderId,
): ImageProviderId | undefined {
  const owner = imageProviderForUrl(url);
  return owner && owner !== actualProvider ? owner : undefined;
}

/** Maps the placeholder onto the model a keyed provider actually serves. */
function resolvedModel(requested: string, fallback: string): string {
  return requested === defaultModelPlaceholder ? fallback : requested;
}

/**
 * Builds an image request URL from the binding's own base URL.
 *
 * The origin is never a constant: it is the endpoint of the very provider configuration the
 * credential came from, which is what makes "credential + destination" inseparable. A binding with
 * no usable absolute HTTP(S) endpoint is refused instead of being replaced by a hard-coded host,
 * because substituting a default destination is exactly the cross-provider disclosure this guards
 * against.
 */
function boundEndpointUrl(binding: ImageProviderBinding, path: string): string {
  const base = binding.endpoint.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/i.test(base)) {
    throw new Error(
      `The ${binding.provider} provider configuration does not name a usable HTTP(S) endpoint, so IRIS refuses to send its credential anywhere.`,
    );
  }
  return `${base}${path}`;
}

/** A binding is only usable when it carries a non-empty credential for the requested provider. */
function usableImageBinding(
  binding: ImageProviderBinding | undefined,
  provider: 'openai' | 'openrouter',
): ImageProviderBinding | undefined {
  if (!binding || binding.provider !== provider) return undefined;
  return binding.apiKey?.trim() ? binding : undefined;
}

export function createImageGenerationTool(
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>,
  credentialResolver?: ImageProviderBindingResolver,
): RegisteredTool {
  const fetchImpl = customFetch || (typeof fetch !== 'undefined' ? fetch : undefined);

  return {
    id: 'image.generate',
    name: 'Generate Image',
    description:
      'Generates an image from a natural language description and reports exactly which provider and model produced it. IRIS never silently switches providers: if the selected provider fails, the tool fails with that provider\'s error.',
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
          description:
            'Provider backend. "auto" picks one provider up front (a configured OpenAI or OpenRouter credential, otherwise the keyless Pollinations gateway) and never switches after a failure.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(input: unknown): Promise<ImageGenerationOutput> {
      if (!input || typeof input !== 'object') {
        throw new Error('Image generation requires an input object with a "prompt" field.');
      }
      assertNoCredentialArguments(input);
      const { prompt, model = defaultModelPlaceholder, size = '1024x1024', style, provider = 'auto' } =
        input as ImageGenerationInput;

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('Prompt must be a non-empty string.');
      }
      // The schema constrains size, but input can arrive through paths that
      // bypass schema validation — an invalid size would otherwise produce a
      // width=NaN request URL.
      if (size && !ALLOWED_SIZES.includes(size)) {
        throw new Error(
          `Invalid size "${size}". Allowed sizes: ${ALLOWED_SIZES.join(', ')}.`,
        );
      }

      if (!fetchImpl) {
        throw new Error('Fetch implementation is not available in the current environment.');
      }

      const enhancedPrompt = style ? `${prompt.trim()}, ${style} style` : prompt.trim();
      const [width, height] = size.split('x').map(Number);

      // Credentials never come from tool arguments: the model's input is
      // untrusted. A resolver supplied by the trusted host layer provides the
      // binding; without one (or without a stored key), a keyed provider
      // fails with a controlled configuration error instead of falling back
      // silently to a different service.
      const resolveBinding = async (
        providerName: 'openai' | 'openrouter',
      ): Promise<ImageProviderBinding> => {
        const binding = usableImageBinding(
          credentialResolver ? await credentialResolver(providerName) : undefined,
          providerName,
        );
        if (!binding) {
          throw new Error(
            `No ${providerName} credential is configured for image generation. Add the API key in the provider configuration and try again.`,
          );
        }
        return { ...binding, apiKey: binding.apiKey.trim() };
      };

      const provenance = (
        actualProvider: ImageProviderId,
        actualModel: string,
        providerOrigin?: string,
      ): Pick<
        ImageGenerationOutput,
        | 'requestedProvider'
        | 'requestedModel'
        | 'actualProvider'
        | 'actualModel'
        | 'providerFallback'
        | 'providerOrigin'
      > => ({
        requestedProvider: provider,
        requestedModel: model,
        actualProvider,
        actualModel,
        providerFallback: provider !== 'auto' && provider !== actualProvider,
        providerOrigin,
      });

      // 'auto' selects exactly one provider before the first request. This is provider selection,
      // not fallback: nothing is retried against a second service after a failure. Each candidate is
      // resolved as a full binding, so the chosen provider is the one whose own configuration holds
      // both the endpoint and the credential.
      let selected: ImageProviderId;
      if (provider === 'auto') {
        const [openaiBinding, openrouterBinding] = await Promise.all([
          credentialResolver ? credentialResolver('openai') : Promise.resolve(undefined),
          credentialResolver ? credentialResolver('openrouter') : Promise.resolve(undefined),
        ]);
        selected = usableImageBinding(openaiBinding, 'openai')
          ? 'openai'
          : usableImageBinding(openrouterBinding, 'openrouter')
            ? 'openrouter'
            : 'pollinations';
      } else {
        selected = provider;
      }

      try {
        if (selected === 'openai') {
          const binding = await resolveBinding('openai');
          const actualModel = resolvedModel(model, 'dall-e-3');
          // The destination comes from the same configuration as the credential: a gateway key is
          // sent to the gateway, an OpenAI key to OpenAI, and never across that boundary.
          const requestUrl = boundEndpointUrl(binding, '/images/generations');
          const res = await fetchImpl(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${binding.apiKey}`,
            },
            body: JSON.stringify({
              model: actualModel,
              prompt: enhancedPrompt,
              n: 1,
              size,
            }),
          });

          if (!res.ok) {
            throw new Error(
              `OpenAI image API failed for model ${actualModel} (${res.status}). No fallback provider was used.`,
            );
          }

          const data = (await res.json()) as {
            data?: Array<{ url?: string; revised_prompt?: string }>;
          };
          const imgUrl = data?.data?.[0]?.url;
          if (!imgUrl) {
            throw new Error(
              `OpenAI image API returned no usable image output for model ${actualModel}. No fallback provider was used.`,
            );
          }
          const owner = mismatchedImageProvider(imgUrl, 'openai');
          if (owner) {
            throw new Error(
              `OpenAI image API returned an image served by ${owner} for model ${actualModel}. IRIS will not relabel another provider's output. No fallback provider was used.`,
            );
          }
          return {
            prompt: prompt.trim(),
            url: imgUrl,
            model: `openai/${actualModel}`,
            revisedPrompt: data?.data?.[0]?.revised_prompt,
            dimensions: size,
            status: 'completed',
            ...provenance('openai', `openai/${actualModel}`, new URL(requestUrl).origin),
          };
        }

        if (selected === 'openrouter') {
          const binding = await resolveBinding('openrouter');
          const actualModel = model.includes('/')
            ? model
            : 'black-forest-labs/flux-1-schnell';
          const requestUrl = boundEndpointUrl(binding, '/chat/completions');
          const res = await fetchImpl(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${binding.apiKey}`,
            },
            body: JSON.stringify({
              model: actualModel,
              messages: [{ role: 'user', content: enhancedPrompt }],
            }),
          });

          if (!res.ok) {
            // M-32: this used to fall through to the Pollinations gateway and report success as if
            // the requested OpenRouter model had produced the image. It never does now.
            throw new Error(
              `OpenRouter image request failed for model ${actualModel} (${res.status}). No fallback provider was used.`,
            );
          }

          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data?.choices?.[0]?.message?.content;
          const imgMatch = content?.match(/https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp)/i);
          if (!imgMatch) {
            throw new Error(
              `OpenRouter returned no usable image output for model ${actualModel} (HTTP ${res.status}). No fallback provider was used.`,
            );
          }
          const owner = mismatchedImageProvider(imgMatch[0], 'openrouter');
          if (owner) {
            // M-32 in its original shape: OpenRouter's answer contained an asset served by a
            // different provider. The old code reported it as the requested OpenRouter model.
            throw new Error(
              `OpenRouter returned an image served by ${owner} for model ${actualModel}. IRIS will not relabel another provider's output. No fallback provider was used.`,
            );
          }
          return {
            prompt: prompt.trim(),
            url: imgMatch[0],
            model: actualModel,
            dimensions: size,
            status: 'completed',
            ...provenance('openrouter', actualModel, new URL(requestUrl).origin),
          };
        }

        // Pollinations. Reached only when it was requested explicitly, or when 'auto' found no
        // configured keyed provider before the request was made.
        const encodedPrompt = encodeURIComponent(enhancedPrompt);
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width || 1024}&height=${height || 1024}&model=flux&nologo=true&seed=${Math.floor(Math.random() * 100000)}`;

        // Verify image availability. HEAD can be rejected by method-restricting
        // gateways (405/501), so fall back to a GET before claiming failure —
        // but never report success for a URL the gateway cannot serve.
        let probe = await fetchImpl(imageUrl, { method: 'HEAD' });
        if (probe.status === 405 || probe.status === 501) {
          probe = await fetchImpl(imageUrl, { method: 'GET' });
        }
        if (!probe.ok) {
          return {
            prompt: prompt.trim(),
            url: imageUrl,
            model: 'pollinations/flux',
            dimensions: size,
            status: 'failed',
            message: `The image gateway could not serve this image (HTTP ${probe.status}).`,
            ...provenance('pollinations', 'pollinations/flux', new URL(imageUrl).origin),
          };
        }

        return {
          prompt: prompt.trim(),
          url: imageUrl,
          model: 'pollinations/flux',
          dimensions: size,
          status: 'completed',
          ...provenance('pollinations', 'pollinations/flux', new URL(imageUrl).origin),
        };
      } catch (err) {
        throw new Error(
          `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
