import { useEffect, useState } from 'react';
import { documentFormats, type DocumentFormat, type IrisDocument } from '@iris/workspaces';
import { documentRepository, notifyDocumentsChanged, subscribeDocuments } from './documents';
import { exportDocument, exportSupported } from './documentExport';
import { staticDocumentPreview } from './documentPreview';
const formatLabels: Record<DocumentFormat, string> = {
  markdown: 'Markdown',
  text: 'Text',
  html: 'HTML',
  svg: 'SVG',
  json: 'JSON',
  csv: 'CSV',
};
function userRevision(content: string) {
  return {
    id: crypto.randomUUID(),
    content,
    createdAt: new Date().toISOString(),
    author: { kind: 'user' as const, id: 'local-user', name: 'You' },
  };
}
function TextPreview({ content, markdown }: { content: string; markdown: boolean }) {
  if (!markdown) return <pre className="document-plain-preview">{content}</pre>;
  return (
    <div className="document-reading">
      {content.split('\n').map((line, index) => {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        return heading ? (
          <p key={index} className={`document-heading level-${heading[1].length}`}>
            {heading[2]}
          </p>
        ) : (
          <p key={index}>{line || '\u00a0'}</p>
        );
      })}
    </div>
  );
}

export function DocumentsState() {
  const [docs, setDocs] = useState<IrisDocument[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [baseRevisionId, setBaseRevisionId] = useState('');
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<DocumentFormat>('markdown');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /**
   * A failed load is not "no documents": the repository retains the corrupt value and refuses every
   * write, so rendering the empty-state invitation would contradict the error alert and tell the
   * user their data is gone when it is still there.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * The single alert slot, which remembers what produced it. A successful reload is only evidence
   * about the *load*: it may clear the load error it supersedes, but it must not wipe an action
   * error (a refused save or export) that the user has not read yet.
   */
  const [alert, setAlert] = useState<{ source: 'load' | 'action'; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [historyId, setHistoryId] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const values = await documentRepository.list();
        if (active) {
          setDocs(values);
          setLoadFailed(false);
          setAlert((current) => (current?.source === 'load' ? null : current));
        }
      } catch (failure) {
        if (active) {
          setAlert({ source: 'load', message: String(failure) });
          setLoadFailed(true);
        }
      } finally {
        if (active) setLoaded(true);
      }
    };
    void load();
    const reload = () => void load();
    const unsubscribe = subscribeDocuments(reload);
    window.addEventListener('focus', reload);
    window.addEventListener('storage', reload);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('focus', reload);
      window.removeEventListener('storage', reload);
    };
  }, [refresh]);
  const selected = docs.find((doc) => doc.id === selectedId);
  const latest = selected?.revisions.at(-1);
  const historic = selected?.revisions.find((revision) => revision.id === historyId);
  const visibleContent = historic?.content ?? content;
  const dirty = Boolean(
    selected &&
    content !== selected.revisions.find((revision) => revision.id === baseRevisionId)?.content,
  );
  const stale = Boolean(selected && latest?.id !== baseRevisionId);
  const hasDraft = dirty || (creating && Boolean(title || content));

  function open(doc: IrisDocument) {
    setSelectedId(doc.id);
    setBaseRevisionId(doc.revisions.at(-1)!.id);
    setContent(doc.revisions.at(-1)!.content);
    setHistoryId('');
    setCreating(false);
    setAlert(null);
    setNotice('');
  }
  async function action(
    kind: 'create' | 'save' | 'export' | 'word' | 'pdf' | 'xlsx' | 'pptx' | 'csv',
  ) {
    setBusy(true);
    setAlert(null);
    setNotice('');
    try {
      if (kind === 'create') {
        const doc = await documentRepository.create({
          id: crypto.randomUUID(),
          title,
          format,
          revision: userRevision(content),
        });
        setDocs(await documentRepository.list());
        open(doc);
        notifyDocumentsChanged();
      } else if (selected && kind === 'save') {
        const doc = await documentRepository.revise(
          selected.id,
          baseRevisionId,
          userRevision(content),
        );
        setDocs(await documentRepository.list());
        open(doc);
        setNotice('Revision saved.');
        notifyDocumentsChanged();
      } else if (selected && kind !== 'save') {
        // `exportDocument` only resolves after the whole target file exists; no notice is shown
        // for partial output or a failed write.
        const path = await exportDocument(
          selected,
          visibleContent,
          kind === 'export' ? 'source' : kind,
        );
        if (path) setNotice(`Exported: ${path}`);
      }
    } catch (failure) {
      setAlert({
        source: 'action',
        message:
          failure instanceof Error ? failure.message : 'The document operation failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="documents-state">
      <header>
        <p className="eyebrow">Documents</p>
        <h2>Work that stays with you.</h2>
        <p>
          Write, review and export real deliverables. Every saved revision keeps its author and
          original content.
        </p>
      </header>
      <div className="documents-toolbar">
        <button
          className="soft-button primary-button"
          disabled={busy || hasDraft}
          onClick={() => {
            setCreating(true);
            setSelectedId('');
            setContent('');
            setTitle('');
            setHistoryId('');
            setNotice('');
          }}
        >
          New document
        </button>
        <button
          className="row-button"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh documents
        </button>
        {hasDraft && <span>Unsaved changes — save or discard before switching documents.</span>}
      </div>
      <div className="documents-layout">
        <aside aria-label="Saved documents">
          {!loaded ? (
            <p>Loading documents…</p>
          ) : loadFailed ? (
            <p role="status">Saved documents could not be read. Existing data has been retained.</p>
          ) : docs.length === 0 ? (
            <p>No documents saved yet.</p>
          ) : (
            docs.map((doc) => (
              <button
                type="button"
                key={doc.id}
                disabled={busy || hasDraft}
                aria-pressed={doc.id === selectedId}
                onClick={() => open(doc)}
              >
                <strong>{doc.title}</strong>
                <small>
                  {formatLabels[doc.format]} · {doc.revisions.length} revisions
                </small>
              </button>
            ))
          )}
        </aside>
        <section className="document-editor">
          {creating ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action('create');
              }}
            >
              <label>
                Title
                <input
                  disabled={busy}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={180}
                  required
                />
              </label>
              <label>
                Format
                <select
                  disabled={busy}
                  value={format}
                  onChange={(event) => setFormat(event.target.value as DocumentFormat)}
                >
                  {documentFormats.map((value) => (
                    <option key={value} value={value}>
                      {formatLabels[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Content
                <textarea
                  disabled={busy}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={14}
                />
              </label>
              <small>
                Up to 256 KiB per revision. Nothing is generated or saved until you create it.
              </small>
              <button className="soft-button primary-button" disabled={busy || !title.trim()}>
                Create document
              </button>
              <button
                type="button"
                className="row-button"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setTitle('');
                  setContent('');
                }}
              >
                Discard draft
              </button>
            </form>
          ) : !selected ? (
            <div className="document-empty">
              <h3>
                {loadFailed ? 'Saved documents could not be read.' : 'A home for your deliverables.'}
              </h3>
              <p>
                {loadFailed
                  ? 'Existing data has been retained and nothing has been overwritten. Resolve the storage problem and refresh.'
                  : 'Create a document, or assign the document tools to an agent. Agent-created documents appear here after they are actually saved.'}
              </p>
            </div>
          ) : (
            <>
              <div className="document-title">
                <h3>{selected.title}</h3>
                <small>
                  {formatLabels[selected.format]} · Latest revision {latest?.number} ·{' '}
                  {latest?.author.name}
                </small>
              </div>
              {stale && (
                <p className="document-warning">
                  A newer revision exists. Your unsaved text has been kept; copy it before reloading
                  if needed.
                </p>
              )}
              <div className="documents-toolbar">
                <button
                  className="soft-button primary-button"
                  disabled={busy || !dirty || stale || Boolean(historyId)}
                  onClick={() => void action('save')}
                >
                  Save revision
                </button>
                <button className="row-button" disabled={busy} onClick={() => open(selected)}>
                  {dirty ? 'Discard unsaved changes' : 'Reload latest'}
                </button>
                <button
                  className="row-button"
                  disabled={busy || dirty}
                  onClick={() => void action('export')}
                >
                  Export original format
                </button>
                {exportSupported('word', selected.format) && (
                  <button
                    className="row-button"
                    disabled={busy || dirty}
                    onClick={() => void action('word')}
                  >
                    Export Word
                  </button>
                )}
                {exportSupported('pdf', selected.format) && (
                  <button
                    className="row-button"
                    disabled={busy || dirty}
                    onClick={() => void action('pdf')}
                  >
                    Export PDF
                  </button>
                )}
                {exportSupported('xlsx', selected.format) && (
                  <button
                    className="row-button"
                    disabled={busy || dirty}
                    onClick={() => void action('xlsx')}
                  >
                    Export XLSX
                  </button>
                )}
                {exportSupported('pptx', selected.format) && (
                  <button
                    className="row-button"
                    disabled={busy || dirty}
                    onClick={() => void action('pptx')}
                  >
                    Export slides
                  </button>
                )}
                {exportSupported('csv', selected.format) && (
                  <button
                    className="row-button"
                    disabled={busy || dirty}
                    onClick={() => void action('csv')}
                  >
                    Export CSV
                  </button>
                )}
              </div>
              <label>
                Revision
                <select
                  value={historyId}
                  disabled={busy || dirty}
                  onChange={(event) => setHistoryId(event.target.value)}
                >
                  <option value="">Current editor</option>
                  {[...selected.revisions].reverse().map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      Revision {revision.number} · {revision.author.name} ·{' '}
                      {new Date(revision.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              {historic && (
                <p>
                  Saved revision {historic.number} is read-only.{' '}
                  <button
                    className="row-button"
                    disabled={busy || historic.id === latest?.id}
                    onClick={() => {
                      setContent(historic.content);
                      setBaseRevisionId(latest!.id);
                      setHistoryId('');
                    }}
                  >
                    Use as new draft
                  </button>
                </p>
              )}
              <div className="document-content-columns">
                <label>
                  {historic ? 'Saved source' : 'Edit content'}
                  <textarea
                    aria-label="Document content"
                    value={visibleContent}
                    readOnly={Boolean(historic)}
                    disabled={busy}
                    onChange={(event) => setContent(event.target.value)}
                  />
                </label>
                <div className="document-preview">
                  <strong>Preview</strong>
                  {selected.format === 'html' || selected.format === 'svg' ? (
                    <iframe
                      title="Static document preview"
                      sandbox=""
                      srcDoc={staticDocumentPreview(visibleContent)}
                    />
                  ) : (
                    <TextPreview
                      content={visibleContent}
                      markdown={selected.format === 'markdown'}
                    />
                  )}
                </div>
              </div>
              <small>
                HTML/SVG previews block scripts and external resources. Word export supports text,
                headings and bullet lists. PDF preserves Latin-1 plain text across as many pages as
                the document needs. XLSX exports quoted comma-separated rows. Slide export creates
                plain text slides; Markdown headings begin a new slide. CSV export writes
                spreadsheet-safe rows and neutralizes leading =, +, - and @. A conversion the source
                format cannot represent is not offered and is refused by the exporter.
              </small>
            </>
          )}
          {notice && <p role="status">{notice}</p>}
          {alert && (
            <p className="workspace-error" role="alert">
              {alert.message}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
