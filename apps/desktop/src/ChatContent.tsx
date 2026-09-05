import type { ModelImage } from '@iris/providers';
import { diffWorkspaceText } from '@iris/workspaces';
import { useRef, useState } from 'react';
import type { ComposerAttachment } from './attachments';
import { DiffViewer } from './DiffViewer';

export function RichMessage({ content }: { content: string }) {
  const tokenPattern = /(https?:\/\/[^\s<]+|\*\*[^*]+\*\*)/g;
  return (
    <>
      {content.split(tokenPattern).map((token, index) => {
        if (/^https?:\/\//.test(token)) {
          const href = token.replace(/[),.;!?]+$/, '');
          const trailing = token.slice(href.length);
          const isImage =
            /\.(?:png|jpg|jpeg|webp|gif)(?:\?.*)?$/i.test(href) ||
            href.includes('pollinations.ai/prompt/') ||
            href.includes('oaidalleapiprodscus');
          if (isImage) {
            return (
              <span key={`${token}-${index}`} style={{ display: 'block', margin: '8px 0' }}>
                <a href={href} target="_blank" rel="noreferrer" style={{ display: 'inline-block' }}>
                  <img
                    src={href}
                    alt="Generated Visual"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '380px',
                      borderRadius: '10px',
                      boxShadow: '0 4px 14px rgba(0,0,0,0.1)',
                      border: '1px solid var(--line)',
                    }}
                  />
                </a>
                {trailing}
              </span>
            );
          }
          return (
            <span key={`${token}-${index}`}>
              <a href={href} target="_blank" rel="noreferrer">
                {href}
              </a>
              {trailing}
            </span>
          );
        }
        if (/^\*\*[^*]+\*\*$/.test(token))
          return <strong key={`${token}-${index}`}>{token.slice(2, -2)}</strong>;
        return <span key={`${token}-${index}`}>{token}</span>;
      })}
    </>
  );
}

export function shortToolLabel(tool: { name: string; providerName?: string }): string {
  const raw = tool.providerName ?? tool.name;
  const withoutPrefix = raw.replace(/^mcp_(?:mcp_)?[0-9a-f-]{20,}_/i, '');
  return withoutPrefix.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** "47s" under a minute, "3m 12s" at or beyond — short enough to sit next to the activity dots. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

/** The "+" attach control: opens a small menu, currently just "Add files or photos". */
export function AttachButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="attach-control">
      <button
        type="button"
        className="attach-button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-label="Add files or photos"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        +
      </button>
      {open && (
        <div className="attach-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              inputRef.current?.click();
            }}
          >
            <span className="attach-menu-icon" aria-hidden="true">
              📎
            </span>
            Add files or photos
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) onFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

/** The chip strip above a chat composer showing what will be sent, or why a file could not be. */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="attachment-chips">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={`attachment-chip ${attachment.error ? 'attachment-chip-error' : ''}`}
        >
          {attachment.kind === 'image' && attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" />
          ) : (
            <span className="attachment-chip-icon" aria-hidden="true">
              {attachment.error ? '!' : '📄'}
            </span>
          )}
          <span className="attachment-chip-name">{attachment.name}</span>
          <button
            type="button"
            className="attachment-chip-remove"
            onClick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
          >
            ×
          </button>
          {attachment.error && <p className="attachment-chip-error-text">{attachment.error}</p>}
        </div>
      ))}
    </div>
  );
}

/** Thumbnails for the images attached to an already-sent message. */
export function MessageImages({ images }: { images?: readonly ModelImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="message-images">
      {images.map((image, index) => (
        <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="Attached" />
      ))}
    </div>
  );
}

function SubAgentCardView({
  input,
  output,
  status,
}: {
  input: Record<string, unknown>;
  output?: unknown;
  status?: 'running' | 'completed' | 'denied' | 'failed';
}) {
  const role = typeof input.role === 'string' ? input.role : 'Specialist';
  const objective = typeof input.objective === 'string' ? input.objective : '';
  const instructions = typeof input.instructions === 'string' ? input.instructions : '';

  return (
    <div className={`subagent-card-view ${status ? `status-${status}` : ''}`}>
      <div className="subagent-card-header">
        <div className="subagent-card-title-group">
          <span className="subagent-card-role">Specialist · {role}</span>
          {status === 'running' && (
            <span className="subagent-status-badge running">
              <span className="activity-dots mini" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Working…
            </span>
          )}
          {status === 'completed' && (
            <span className="subagent-status-badge completed">Completed</span>
          )}
        </div>
        {typeof input.model === 'string' ? (
          <span className="subagent-card-model">{input.model}</span>
        ) : null}
      </div>
      <div className="subagent-card-objective">
        <strong>Objective:</strong> {objective}
      </div>
      {instructions ? (
        <details className="subagent-card-instructions">
          <summary>Instructions & Context</summary>
          <pre>{instructions}</pre>
        </details>
      ) : null}
      {output && typeof output === 'object' && 'output' in (output as Record<string, unknown>) ? (
        <div className="subagent-card-result">
          <strong>Findings & Report:</strong>
          <pre>{String((output as Record<string, unknown>).output)}</pre>
        </div>
      ) : null}
    </div>
  );
}

/** Drop handlers so files dragged from the OS land in the composer like picked ones. */
export function composerDropHandlers(onFiles: (files: FileList) => void) {
  return {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (files?.length) onFiles(files);
    },
  };
}
function describeToolRequest(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return typeof input === 'string' ? input : (JSON.stringify(input) ?? String(input));
  }
  const value = input as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof value.path === 'string') lines.push(`Path · ${value.path}`);
  if (typeof value.sourcePath === 'string') lines.push(`Move from · ${value.sourcePath}`);
  if (typeof value.targetPath === 'string') lines.push(`Move to · ${value.targetPath}`);
  if (typeof value.overwrite === 'boolean') {
    lines.push(`Overwrite existing file · ${value.overwrite ? 'yes' : 'no'}`);
  }
  if (typeof value.content === 'string') {
    const preview = value.content.length > 280 ? `${value.content.slice(0, 280)}…` : value.content;
    lines.push(`Content · ${value.content.length} characters\n${preview}`);
  }
  if (typeof value.expectedContent === 'string' && typeof value.updatedContent === 'string') {
    const diff = diffWorkspaceText(value.expectedContent, value.updatedContent, 80);
    lines.push(
      `Patch preview · ${diff.changed ? 'changes requested' : 'no changes'}\n${diff.lines.map((line) => line.text).join('\n')}${diff.truncated ? '\n… preview truncated' : ''}`,
    );
  }
  const remaining = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        ![
          'path',
          'sourcePath',
          'targetPath',
          'overwrite',
          'content',
          'expectedContent',
          'updatedContent',
        ].includes(key),
    ),
  );
  if (Object.keys(remaining).length > 0) lines.push(JSON.stringify(remaining, null, 2));
  return lines.join('\n') || '{}';
}

export function formatMemoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function ToolRequestView({ input, output }: { input: unknown; output?: unknown }) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (typeof value.role === 'string' && typeof value.objective === 'string') {
      return <SubAgentCardView input={value} output={output} />;
    }
    if (typeof value.expectedContent === 'string' && typeof value.updatedContent === 'string') {
      const remaining = Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => key !== 'expectedContent' && key !== 'updatedContent',
        ),
      );
      return (
        <div className="tool-request-view">
          {Object.keys(remaining).length > 0 ? <pre>{describeToolRequest(remaining)}</pre> : null}
          <DiffViewer
            originalText={value.expectedContent}
            modifiedText={value.updatedContent}
            title={typeof value.path === 'string' ? `Patch · ${value.path}` : 'Patch Diff'}
          />
        </div>
      );
    }
  }
  return <pre>{describeToolRequest(input)}</pre>;
}
