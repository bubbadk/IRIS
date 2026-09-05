// Produce plain readable release text; never interpret publisher HTML as UI.
export function readableReleaseNotes(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasReleaseSummary(notes: string, version: string): boolean {
  const text = readableReleaseNotes(notes)
    .replace(/https?:\/\/\S+/g, '')
    .replaceAll(version, '')
    .replace(
      /\b(?:IRIS|version|release|notes|changelog|full|see|on|GitHub|compare|what.s new)\b/gi,
      '',
    )
    .replace(/[^\p{L}\p{N}]/gu, '');
  return text.length >= 20;
}

export function verifyUpdateTarget(
  release: { version: string; notes: string },
  targetVersion: string,
): void {
  if (release.version !== targetVersion) {
    throw new Error(
      `The update target changed to ${targetVersion}. Reopen IRIS to review that version's release notes before installing.`,
    );
  }
  if (!hasReleaseSummary(release.notes, release.version)) {
    throw new Error(
      `Version ${release.version} has no usable release summary. Installation is unavailable until release notes are published.`,
    );
  }
}

/** Native verification remains authoritative; reject obviously unsigned metadata before download. */
export function verifyUpdateSignatureMetadata(raw: Record<string, unknown>): void {
  const entries =
    raw.platforms && typeof raw.platforms === 'object' ? Object.values(raw.platforms) : [raw];
  const hasSignature = entries.some(
    (entry: unknown) =>
      entry &&
      typeof entry === 'object' &&
      'signature' in entry &&
      typeof entry.signature === 'string' &&
      entry.signature.trim().length > 0,
  );
  if (!hasSignature) {
    throw new Error(
      'This release does not provide a signed update package. Automatic installation is unavailable; open the release page for manual download.',
    );
  }
}
