import type { ProjectResultChecker } from '@iris/workflows';
import { documentRepository } from './documents';
import { workspaceService } from './workspace';

export function createProjectResultChecker(
  documents: Pick<typeof documentRepository, 'list'> = documentRepository,
  workspace: Pick<typeof workspaceService, 'readForCheck'> = workspaceService,
): ProjectResultChecker {
  return {
    async read(target) {
      if (target.kind === 'document') {
        const matches = (await documents.list()).filter((doc) => doc.title === target.title);
        if (matches.length > 1)
          throw new Error('Several documents have this title. Use a unique title before checking.');
        const doc = matches[0];
        if (!doc) return null;
        const revision = doc.revisions.at(-1)!;
        return {
          content: revision.content,
          evidence: `Document ${doc.id}, revision ${revision.number} (${revision.id}).`,
        };
      }
      const file = await workspace.readForCheck(target.rootPath, target.path);
      if (!file) return null;
      if (file.truncated)
        throw new Error('The file exceeds the read limit; its full content was not checked.');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.content));
      const digest = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return {
        content: file.content,
        evidence: `${target.rootPath}/${file.relativePath}, ${file.bytesRead} bytes; SHA-256 ${digest}.`,
      };
    },
  };
}
export const projectResultChecker = createProjectResultChecker();
