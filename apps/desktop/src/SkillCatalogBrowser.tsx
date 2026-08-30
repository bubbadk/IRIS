import { useCallback, useEffect, useState } from 'react';
import type {
  SkillCatalogEntry,
  SkillCatalogPage,
  SkillDefinition,
  SkillInstructions,
} from '@iris/skills';
import { catalogInstructionsAreDescriptionOnly, findImportedSkill } from '@iris/skills';
import { skillCatalog, skillCatalogPageSize } from './skillCatalog';
import { importCatalogSkill, previewCatalogSkill } from './skills';

interface SkillCatalogBrowserProps {
  installed: SkillDefinition[];
  onImported: (skill: SkillDefinition) => void;
}

interface PreviewState {
  entry: SkillCatalogEntry;
  instructions: SkillInstructions;
}

export function SkillCatalogBrowser({ installed, onImported }: SkillCatalogBrowserProps) {
  const catalog = skillCatalog.descriptor();
  const [page, setPage] = useState<SkillCatalogPage | null>(null);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [category, setCategory] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewSlug, setPreviewSlug] = useState('');
  const [busySlug, setBusySlug] = useState('');

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const result = await skillCatalog.browse(
          {
            query: submittedQuery,
            category,
            page: pageNumber,
            limit: skillCatalogPageSize,
          },
          signal,
        );
        if (!signal.aborted) setPage(result);
      } catch (browseError) {
        if (signal.aborted) return;
        setPage(null);
        setError(
          browseError instanceof Error
            ? `${catalog.name} is unavailable: ${browseError.message}`
            : `${catalog.name} is unavailable.`,
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [catalog.name, category, pageNumber, submittedQuery],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    setPageNumber(1);
    setSubmittedQuery(query.trim());
  }

  async function openPreview(entry: SkillCatalogEntry) {
    setPreviewSlug(entry.slug);
    setError('');
    try {
      setPreview({ entry, instructions: await previewCatalogSkill(entry) });
    } catch (previewError) {
      setPreview(null);
      setError(
        previewError instanceof Error
          ? previewError.message
          : 'That skill could not be read from the catalog.',
      );
    } finally {
      setPreviewSlug('');
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setBusySlug(preview.entry.slug);
    setError('');
    try {
      const skill = await importCatalogSkill(preview.entry, preview.instructions);
      setPreview(null);
      onImported(skill);
    } catch (importError) {
      setError(
        importError instanceof Error ? importError.message : 'That skill could not be imported.',
      );
    } finally {
      setBusySlug('');
    }
  }

  function importedSkill(entry: SkillCatalogEntry): SkillDefinition | null {
    return findImportedSkill(installed, catalog.id, entry.slug);
  }

  const descriptionOnly = preview
    ? catalogInstructionsAreDescriptionOnly(preview.entry, preview.instructions.body)
    : false;

  return (
    <div className="skill-catalog">
      <form className="skill-catalog-toolbar" onSubmit={search}>
        <input
          value={query}
          placeholder={`Search ${catalog.name}…`}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          value={category}
          onChange={(event) => {
            setPageNumber(1);
            setCategory(event.target.value);
          }}
        >
          <option value="">All categories</option>
          {skillCatalog.categories().map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button className="row-button" type="submit" disabled={loading}>
          Search
        </button>
      </form>

      {error && <p className="skills-error">{error}</p>}

      {preview && (
        <section className="skill-catalog-preview" aria-label="Skill preview">
          <div className="skill-detail-heading">
            <div>
              <p className="eyebrow">
                {descriptionOnly ? 'Nothing to import' : 'Review before importing'}
              </p>
              <h3>
                {preview.entry.icon ? `${preview.entry.icon} ` : ''}
                {preview.entry.name}
              </h3>
            </div>
            <div className="skill-detail-actions">
              <button className="row-button" onClick={() => setPreview(null)}>
                {descriptionOnly ? 'Close' : 'Cancel'}
              </button>
              {!descriptionOnly && (
                <button
                  className="soft-button primary-button"
                  disabled={Boolean(busySlug)}
                  onClick={() => void confirmImport()}
                >
                  {busySlug ? 'Importing…' : 'Import skill'}
                </button>
              )}
            </div>
          </div>
          {descriptionOnly ? (
            <p className="skill-summary">
              This entry carries no instructions. Its instruction field in {catalog.name} only
              repeats its own description, so importing it would tell an agent it has a capability
              without telling it how to use one. IRIS will not store that as a skill.
            </p>
          ) : (
            <p className="skill-summary">
              This is the exact instruction text that will be injected into a turn once you assign
              it to an agent. It grants no tool authority.
            </p>
          )}
          <pre className="skill-instructions">{preview.instructions.body}</pre>
          <p className="skill-catalog-meta">
            {preview.instructions.body.length} characters ·{' '}
            {preview.instructions.origin === 'repository'
              ? `read from the skill's source repository · ${preview.instructions.url}`
              : `from ${catalog.name}`}
          </p>
          {descriptionOnly && preview.entry.sourceUrl && (
            <p className="skill-catalog-meta">
              IRIS checked the linked source repository but found no readable instruction document,
              so it will not guess at the content.
            </p>
          )}
        </section>
      )}

      {loading ? (
        <div className="skills-empty">Loading {catalog.name}…</div>
      ) : !page ? (
        <div className="skills-empty">
          <strong>Catalog unavailable</strong>
          <p>
            IRIS could not reach {catalog.name}. Nothing is shown from cache, because a stale list
            would not tell you what is really available.
          </p>
        </div>
      ) : page.entries.length === 0 ? (
        <div className="skills-empty">
          <strong>No match</strong>
          <p>No skill in {catalog.name} matches this search.</p>
        </div>
      ) : (
        <>
          <p className="skill-catalog-count">
            {page.total} skill{page.total === 1 ? '' : 's'} in {catalog.name} · page {page.page} of{' '}
            {page.totalPages}
          </p>
          <div className="skill-catalog-grid">
            {page.entries.map((entry) => {
              const already = importedSkill(entry);
              return (
                <article className="skill-catalog-card" key={entry.slug}>
                  <div className="skill-catalog-card-head">
                    <strong>
                      {entry.icon ? `${entry.icon} ` : ''}
                      {entry.name}
                    </strong>
                    <em>{entry.category}</em>
                  </div>
                  <p>{entry.description}</p>
                  <div className="skill-catalog-card-foot">
                    <small>{entry.importCount.toLocaleString()} imports</small>
                    {already ? (
                      <span className="skill-catalog-installed">Imported</span>
                    ) : (
                      <button
                        className="row-button"
                        disabled={previewSlug === entry.slug}
                        onClick={() => void openPreview(entry)}
                      >
                        {previewSlug === entry.slug ? 'Loading…' : 'Preview'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="skill-catalog-pager">
            <button
              className="row-button"
              disabled={page.page <= 1}
              onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <span>
              {page.page} / {page.totalPages}
            </span>
            <button
              className="row-button"
              disabled={page.page >= page.totalPages}
              onClick={() => setPageNumber((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
