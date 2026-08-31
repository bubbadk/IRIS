import { useEffect, useState } from 'react';
import type { AgentDefinition } from '@iris/core';
import {
  nextIdleScheduleRun,
  nextScheduleRun,
  isoToZonedDateTime,
  zonedDateTimeToIso,
  type ScheduleDefinition,
  type ScheduleRecurrence,
  type ScheduledRun,
} from '@iris/workflows';
import { agentRepository, scheduleRepository, scheduledRunRepository } from './persistence';
import { resolveScheduledApproval, subscribeScheduleRuntime } from './scheduledRuntime';
import { lastUserActivityAt } from './userActivity';

const dreamingPromptSuggestion =
  'Review today’s conversation and tool activity. Save only what is genuinely worth ' +
  'remembering long-term via memory.remember — concrete facts, decisions and preferences, ' +
  'not trivial detail. If there is nothing worth keeping, do nothing and say so briefly.';

const timeZones = (() => {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  const supported = supportedValuesOf?.('timeZone') ?? [];
  return [
    ...new Set(
      ['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...supported].filter(Boolean),
    ),
  ].sort();
})();
const weekdayOptions = [
  ['Sunday', 0],
  ['Monday', 1],
  ['Tuesday', 2],
  ['Wednesday', 3],
  ['Thursday', 4],
  ['Friday', 5],
  ['Saturday', 6],
] as const;

export function scheduleDateLabel(value?: string, timeZone?: string): string {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}

interface SchedulePreset {
  title: string;
  badge: string;
  description: string;
  name: string;
  recurrence: ScheduleRecurrence;
  timeOfDay: string;
  idleMinutes?: number;
  prompt: string;
}

const schedulePresets: SchedulePreset[] = [
  {
    title: 'Morgen IT-Nyheder',
    badge: 'Daglig 08:00',
    description: 'Søger og opsummerer det seneste døgns vigtigste tech-, AI- og softwarenyheder.',
    name: 'Morgen IT- & Tech-overblik',
    recurrence: 'daily',
    timeOfDay: '08:00',
    prompt:
      'Søg efter og opsummer de vigtigste IT-, software- og AI-nyheder fra det seneste døgn. Fremhæv kritiske sikkerhedsbulletiner, nye open source releases og AI-gennembrud i et klart punktformat.',
  },
  {
    title: 'Indbakke & Mail Check',
    badge: 'Daglig 09:00',
    description: 'Gennemgår ulæste henvendelser og laver et handlingsresumé over vigtige punkter.',
    name: 'Daglig Indbakke Opsummering',
    recurrence: 'daily',
    timeOfDay: '09:00',
    prompt:
      'Gennemgå ulæste meddelelser og kanaler. Udarbejd et kortfattet handlingsresumé over ting, der kræver svar eller opmærksomhed i dag, sorteret efter prioritet.',
  },
  {
    title: 'Workspace Oprydning',
    badge: 'Daglig 17:00',
    description: 'Tjekker workspace-status, git-ændringer og rapporterer kodehelbred.',
    name: 'Workspace Sundhedstjek',
    recurrence: 'daily',
    timeOfDay: '17:00',
    prompt:
      'Gennemgå det monterede workspace. Tjek git status, opsummer dagens kodeændringer, identificer midlertidige filer (.tmp, caches) og giv et kort statusoverblik.',
  },
  {
    title: 'Aften Dreaming',
    badge: 'Inaktivitet (60 min)',
    description: 'Konsoliderer dagens viden og vigtige beslutninger til langtidshukommelsen.',
    name: 'Aften Dreaming & Hukommelse',
    recurrence: 'idle',
    timeOfDay: '22:00',
    idleMinutes: 60,
    prompt: dreamingPromptSuggestion,
  },
  {
    title: 'System- & Sikkerhedstjek',
    badge: 'Ugentlig Mandag',
    description: 'Ugentlig gennemgang af maskinstatus, diskforbrug og agentrettigheder.',
    name: 'Ugentlig Systemaudit',
    recurrence: 'weekly',
    timeOfDay: '09:00',
    prompt:
      'Kør en system- og værktøjsaudit. Evaluer diskforbrug, CPU, aktive forbindelser og verificer at agent-rettigheder er opdaterede.',
  },
];

export function SchedulesState() {
  const [schedules, setSchedules] = useState<ScheduleDefinition[]>([]);
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>('daily');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [timeZone, setTimeZone] = useState(timeZones[0] ?? 'UTC');
  const [runAt, setRunAt] = useState('');
  const [idleMinutes, setIdleMinutes] = useState(60);
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [error, setError] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string>();

  function applyPreset(preset: SchedulePreset) {
    setName(preset.name);
    setPrompt(preset.prompt);
    setRecurrence(preset.recurrence);
    setTimeOfDay(preset.timeOfDay);
    if (preset.idleMinutes) setIdleMinutes(preset.idleMinutes);
    if (preset.recurrence === 'weekly') setWeekdays([1]);
    setError('');
  }

  async function refresh() {
    const [storedSchedules, storedRuns, storedAgents] = await Promise.all([
      scheduleRepository.list(),
      scheduledRunRepository.list(),
      agentRepository.list(),
    ]);
    setSchedules(storedSchedules);
    setRuns(storedRuns);
    setAgents(storedAgents);
    setAgentId((current) => current || storedAgents[0]?.id || '');
  }

  useEffect(() => {
    void refresh();
    return subscribeScheduleRuntime(() => void refresh());
  }, []);

  function resetEditor() {
    setName('');
    setPrompt('');
    setRecurrence('daily');
    setWeekdays([1]);
    setTimeOfDay('09:00');
    setRunAt('');
    setIdleMinutes(60);
    setMaxAttempts(1);
    setEditing(false);
    setEditingId(undefined);
    setError('');
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!agentId) return setError('Create and configure an agent before scheduling a run.');
    if (!name.trim() || !prompt.trim() || (recurrence === 'once' && !runAt)) {
      setError('Add a name, prompt and valid timing before saving.');
      return;
    }
    const parsedRunAt = recurrence === 'once' ? zonedDateTimeToIso(runAt, timeZone) : undefined;
    if (recurrence === 'once' && !parsedRunAt) {
      setError('Choose a valid one-time run date.');
      return;
    }
    const now = new Date().toISOString();
    const selectedWeekdays = [...new Set(weekdays)].sort((a, b) => a - b);
    const schedule: ScheduleDefinition = {
      version: 1,
      id: editingId ?? crypto.randomUUID(),
      name: name.trim(),
      agentId,
      prompt: prompt.trim(),
      recurrence,
      timeOfDay,
      timeZone,
      ...(parsedRunAt ? { runAt: parsedRunAt } : {}),
      ...(recurrence === 'weekly' ? { weekdays: selectedWeekdays } : {}),
      ...(recurrence === 'idle' ? { idleMinutes: Math.max(1, Math.floor(idleMinutes)) } : {}),
      enabled: editingId
        ? (schedules.find((candidate) => candidate.id === editingId)?.enabled ?? true)
        : true,
      maxAttempts,
      createdAt: editingId
        ? (schedules.find((candidate) => candidate.id === editingId)?.createdAt ?? now)
        : now,
      updatedAt: now,
      nextRunAt:
        recurrence === 'idle'
          ? nextIdleScheduleRun({ idleMinutes }, lastUserActivityAt())
          : nextScheduleRun(
              {
                recurrence,
                timeOfDay,
                timeZone,
                runAt: parsedRunAt,
                weekdays: recurrence === 'weekly' ? selectedWeekdays : undefined,
              },
              new Date(),
            ),
    };
    if (recurrence === 'weekly' && selectedWeekdays.length === 0) {
      setError('Choose at least one weekday for a weekly schedule.');
      return;
    }
    try {
      await scheduleRepository.save(schedule);
      await refresh();
      resetEditor();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The schedule could not be saved.');
    }
  }

  async function toggle(schedule: ScheduleDefinition) {
    const updated = {
      ...schedule,
      enabled: !schedule.enabled,
      updatedAt: new Date().toISOString(),
    };
    await scheduleRepository.save(updated);
    await refresh();
  }

  function beginEdit(schedule: ScheduleDefinition) {
    setEditing(true);
    setEditingId(schedule.id);
    setName(schedule.name);
    setAgentId(schedule.agentId);
    setPrompt(schedule.prompt);
    setRecurrence(schedule.recurrence);
    setWeekdays(schedule.weekdays?.length ? [...schedule.weekdays] : [1]);
    setTimeOfDay(schedule.timeOfDay);
    setTimeZone(schedule.timeZone);
    setRunAt(
      schedule.recurrence === 'once' && schedule.runAt
        ? (isoToZonedDateTime(schedule.runAt, schedule.timeZone) ?? '')
        : '',
    );
    setIdleMinutes(schedule.idleMinutes ?? 60);
    setMaxAttempts(schedule.maxAttempts ?? 1);
    setError('');
  }

  async function remove(schedule: ScheduleDefinition) {
    await scheduleRepository.remove(schedule.id);
    await refresh();
  }

  return (
    <div className="schedules-state">
      <header className="projects-heading">
        <div>
          <p className="eyebrow">Local schedules</p>
          <h2>Give recurring work a quiet rhythm.</h2>
          <p>
            Schedules and run outcomes are stored locally. Agent tools still follow the shared
            permission rules.
          </p>
        </div>
        <button
          className="soft-button primary-button"
          onClick={() => {
            resetEditor();
            setEditing(true);
          }}
        >
          ＋ New schedule
        </button>
      </header>

      {editing && (
        <form className="schedule-editor" onSubmit={(event) => void save(event)}>
          <div className="schedule-presets-section">
            <div className="schedule-presets-header">
              <span className="schedule-presets-title">⚡ Hurtige skabeloner</span>
              <span className="schedule-presets-subtitle">Vælg et forudindstillet job for at udfylde felterne automatisk:</span>
            </div>
            <div className="schedule-presets-grid">
              {schedulePresets.map((preset) => (
                <button
                  type="button"
                  key={preset.title}
                  className="schedule-preset-card"
                  onClick={() => applyPreset(preset)}
                >
                  <div className="preset-card-top">
                    <strong className="preset-card-title">{preset.title}</strong>
                    <span className="preset-card-badge">{preset.badge}</span>
                  </div>
                  <p className="preset-card-desc">{preset.description}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="schedule-main-fields">
            <label className="schedule-field-full">
              Schedule name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="f.eks. Morgen IT- & Tech-overblik"
              />
            </label>
            <label className="schedule-field-full">
              Agent
              <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                <option value="">Choose an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="schedule-prompt-field">
            Prompt / Instruktion
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Beskriv hvad agenten skal gøre ved hvert kørsel…"
              rows={4}
            />
          </label>

          <div className="schedule-timing-grid">
            <label>
              Gentagelse
              <select
                value={recurrence}
                onChange={(event) => {
                  const next = event.target.value as ScheduleRecurrence;
                  setRecurrence(next);
                  if (next === 'idle' && !prompt.trim()) setPrompt(dreamingPromptSuggestion);
                }}
              >
                <option value="once">Enkelt kørsel (Once)</option>
                <option value="daily">Dagligt (Daily)</option>
                <option value="weekly">Ugentligt (Weekly)</option>
                <option value="idle">Ved inaktivitet (Dreaming)</option>
              </select>
            </label>

            {recurrence === 'idle' ? (
              <label>
                Minutters inaktivitet
                <input
                  type="number"
                  min="1"
                  value={idleMinutes}
                  onChange={(event) => setIdleMinutes(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
            ) : (
              <>
                <label>
                  Klokkeslæt
                  <input
                    type="time"
                    value={timeOfDay}
                    onChange={(event) => setTimeOfDay(event.target.value)}
                  />
                </label>
                <label>
                  Tidszone
                  <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
                    {timeZones.map((zone) => (
                      <option key={zone}>{zone}</option>
                    ))}
                  </select>
                </label>
              </>
            )}

            <label>
              Maks forsøg
              <input
                type="number"
                min="1"
                max="10"
                value={maxAttempts}
                onChange={(event) =>
                  setMaxAttempts(Math.min(10, Math.max(1, Number(event.target.value) || 1)))
                }
              />
            </label>

            {recurrence === 'once' && (
              <label className="schedule-field-span">
                Kørselstidspunkt
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </label>
            )}

            {recurrence === 'weekly' && (
              <fieldset className="weekday-picker schedule-field-span">
                <legend>Ugedage</legend>
                {weekdayOptions.map(([label, day]) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={weekdays.includes(day)}
                      onChange={(event) =>
                        setWeekdays((current) =>
                          event.target.checked
                            ? [...current, day]
                            : current.filter((value) => value !== day),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            )}
          </div>

          {error && <p className="inline-error">{error}</p>}
          <div className="schedule-editor-actions">
            <button type="button" className="row-button" onClick={resetEditor}>
              Cancel
            </button>
            <button className="soft-button primary-button">
              {editingId ? 'Opdater tidsplan' : 'Gem tidsplan'}
            </button>
          </div>
        </form>
      )}

      {schedules.length === 0 ? (
        <div className="projects-empty">
          <strong>No schedules yet</strong>
          <p>IRIS will not invent timing or run history. Create a schedule above.</p>
        </div>
      ) : (
        <div className="schedule-list">
          {schedules.map((schedule) => (
            <article className="schedule-card" key={schedule.id}>
              <div>
                <p className="eyebrow">
                  {schedule.recurrence === 'idle'
                    ? `idle · after ${schedule.idleMinutes ?? 60}m quiet`
                    : `${schedule.recurrence} · ${schedule.timeZone}`}
                  {schedule.recurrence === 'weekly' && schedule.weekdays
                    ? ` · ${schedule.weekdays.map((day) => weekdayOptions.find(([, value]) => value === day)?.[0]).join(', ')}`
                    : ''}
                </p>
                <h3>{schedule.name}</h3>
                <p>{schedule.prompt}</p>
                <small>
                  Next run:{' '}
                  {schedule.enabled
                    ? scheduleDateLabel(schedule.nextRunAt, schedule.timeZone)
                    : 'Paused'}
                </small>
              </div>
              <div className="schedule-actions">
                <button className="row-button" onClick={() => beginEdit(schedule)}>
                  Edit
                </button>
                <button className="row-button" onClick={() => void toggle(schedule)}>
                  {schedule.enabled ? 'Pause' : 'Enable'}
                </button>
                <button className="row-button danger-button" onClick={() => void remove(schedule)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <section className="schedule-history">
        <p className="eyebrow">Run history</p>
        <h3>Observed runs</h3>
        {runs.length === 0 ? (
          <p className="muted-copy">No scheduled run has been recorded yet.</p>
        ) : (
          runs.map((run) => (
            <div className="history-row" key={run.id}>
              <button
                className="history-summary"
                onClick={() =>
                  setSelectedRunId((current) => (current === run.id ? undefined : run.id))
                }
              >
                <strong>
                  {run.status}
                  {run.attempt ? ` · attempt ${run.attempt}/${run.maxAttempts}` : ''}
                </strong>
                <span>
                  {scheduleDateLabel(
                    run.scheduledFor,
                    schedules.find((schedule) => schedule.id === run.scheduleId)?.timeZone,
                  )}
                </span>
                <span>
                  {run.failure ??
                    run.output ??
                    (run.status === 'suspended'
                      ? 'Waiting for permission approval.'
                      : 'No outcome recorded.')}
                </span>
              </button>
              {selectedRunId === run.id && (
                <div className="history-details">
                  <span>Agent: {run.agentId}</span>
                  <span>Prompt: {run.prompt}</span>
                  <span>
                    Created: {scheduleDateLabel(run.createdAt)} · Started:{' '}
                    {scheduleDateLabel(run.startedAt)} · Updated: {scheduleDateLabel(run.updatedAt)}
                  </span>
                  {(run.completedAt || run.failedAt) && (
                    <span>
                      {run.completedAt
                        ? `Completed: ${scheduleDateLabel(run.completedAt)}`
                        : `Failed: ${scheduleDateLabel(run.failedAt)}`}
                    </span>
                  )}
                  {run.retryAt && <span>Retry: {scheduleDateLabel(run.retryAt)}</span>}
                  {run.approvalId && <span>Approval: {run.approvalId}</span>}
                  {run.status === 'suspended' && run.approvalId && (
                    <div>
                      <button
                        className="row-button approval-button"
                        onClick={() =>
                          void resolveScheduledApproval(run, 'approve')
                            .then(refresh)
                            .catch((e) =>
                              setError(
                                e instanceof Error ? e.message : 'Approval could not be resolved.',
                              ),
                            )
                        }
                      >
                        Approve
                      </button>
                      <button
                        className="row-button"
                        onClick={() =>
                          void resolveScheduledApproval(run, 'deny')
                            .then(refresh)
                            .catch((e) =>
                              setError(
                                e instanceof Error ? e.message : 'Approval could not be resolved.',
                              ),
                            )
                        }
                      >
                        Deny
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
