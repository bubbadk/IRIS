export const CURRENT_VERSION = __IRIS_VERSION__;

export interface ReleaseInfo {
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  url: string;
  downloadUrl?: string;
}

export function parseSemver(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((num) => parseInt(num, 10) || 0);
}

export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i += 1) {
    const cNum = c[i] ?? 0;
    const lNum = l[i] ?? 0;
    if (lNum > cNum) return true;
    if (lNum < cNum) return false;
  }
  return false;
}

export async function checkLatestRelease(
  repo = 'bubbadk/IRIS',
  fetcher = globalThis.fetch,
): Promise<ReleaseInfo | null> {
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      tag_name?: string;
      name?: string;
      body?: string;
      published_at?: string;
      html_url?: string;
      assets?: Array<{ browser_download_url?: string; name?: string }>;
    };
    if (!data.tag_name) return null;

    const latestVersion = data.tag_name.replace(/^v/, '');
    if (!isNewerVersion(CURRENT_VERSION, latestVersion)) return null;

    return {
      version: latestVersion,
      name: data.name || `IRIS v${latestVersion}`,
      notes: data.body?.trim() || '',
      publishedAt: data.published_at || '',
      url: data.html_url || `https://github.com/${repo}/releases/tag/${data.tag_name}`,
      downloadUrl: data.html_url,
    };
  } catch {
    return null;
  }
}
