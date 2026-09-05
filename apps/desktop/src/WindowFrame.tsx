import { lazy, Suspense, useEffect, useRef } from 'react';
import type { IrisObjectType } from '@iris/core';
import { CloseIcon, IrisMark } from './icons';
const AgentsState = lazy(() => import('./AgentsState').then((module) => ({ default: module.AgentsState })));
const ChannelsWindow = lazy(() => import('./ChannelsState').then((module) => ({ default: module.ChannelsWindow })));
const GitHubState = lazy(() => import('./GitHubState').then((module) => ({ default: module.GitHubState })));
const McpState = lazy(() => import('./McpState').then((module) => ({ default: module.McpState })));
const MemoryState = lazy(() => import('./MemoryState').then((module) => ({ default: module.MemoryState })));
const ModelsState = lazy(() => import('./ModelsState').then((module) => ({ default: module.ModelsState })));
const PermissionsState = lazy(() => import('./PermissionsState').then((module) => ({ default: module.PermissionsState })));
const ProjectsState = lazy(() => import('./ProjectsState').then((module) => ({ default: module.ProjectsState })));
const SchedulesState = lazy(() => import('./SchedulesState').then((module) => ({ default: module.SchedulesState })));
const SkillsState = lazy(() => import('./SkillsState').then((module) => ({ default: module.SkillsState })));
const SubtitlesState = lazy(() => import('./SubtitlesState').then((module) => ({ default: module.SubtitlesState })));
const WorkspaceState = lazy(() => import('./WorkspaceState').then((module) => ({ default: module.WorkspaceState })));
import {
  moveWindow,
  resizeWindow,
  type DesktopWindow,
} from './windowing';
import { objects } from './desktopObjects';

function EmptyState({ type }: { type: IrisObjectType }) {
  const item = objects.find((entry) => entry.type === type)!;
  const Icon = item.Icon;
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon />
      </div>
      <p className="eyebrow">{item.label}</p>
      <h2>{item.description}</h2>
      <p>
        This area is ready, but nothing has been configured yet. IRIS will show real state here once
        the corresponding runtime slice exists.
      </p>
      <div className="truth-pill">Not configured</div>
    </div>
  );
}

function WelcomeState() {
  return (
    <div className="empty-state welcome-state">
      <div className="empty-icon iris-empty">
        <IrisMark />
      </div>
      <p className="eyebrow">IRIS</p>
      <h2>Your intelligent workspace starts empty on purpose.</h2>
      <p>
        Open an object from the desktop or dock. As providers, agents and memory are added, this
        workspace becomes a live view of the real system rather than a simulated dashboard.
      </p>
    </div>
  );
}

export function WindowFrame({
  win,
  onClose,
  onFocus,
  onChange,
  onOpenProject,
}: {
  win: DesktopWindow;
  onClose: () => void;
  onFocus: () => void;
  onChange: (next: DesktopWindow) => void;
  onOpenProject?: (id: string) => void;
}) {
  const frameRef = useRef<HTMLElement | null>(null);
  const interactionRef = useRef<{
    kind: 'move' | 'resize';
    pointerId: number;
    start: DesktopWindow;
    startX: number;
    startY: number;
    grabX: number;
    grabY: number;
    latest: DesktopWindow;
    animationFrame: number | null;
  } | null>(null);

  function paintInteraction() {
    const interaction = interactionRef.current;
    const frame = frameRef.current;
    if (!interaction || !frame) return;

    if (interaction.kind === 'move') {
      const deltaX = interaction.latest.x - interaction.start.x;
      const deltaY = interaction.latest.y - interaction.start.y;
      frame.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    } else {
      frame.style.width = `${interaction.latest.width}px`;
      frame.style.height = `${interaction.latest.height}px`;
    }
    interaction.animationFrame = null;
  }

  function scheduleInteraction(next: DesktopWindow) {
    const interaction = interactionRef.current;
    if (!interaction) return;
    interaction.latest = next;
    if (interaction.animationFrame === null) {
      interaction.animationFrame = requestAnimationFrame(paintInteraction);
    }
  }

  function finishInteraction(pointerId: number) {
    const interaction = interactionRef.current;
    const frame = frameRef.current;
    if (!interaction || interaction.pointerId !== pointerId) return;

    if (interaction.animationFrame !== null) {
      cancelAnimationFrame(interaction.animationFrame);
      interaction.animationFrame = null;
    }
    paintInteraction();

    if (frame) {
      frame.style.left = `${interaction.latest.x}px`;
      frame.style.top = `${interaction.latest.y}px`;
      frame.style.width = `${interaction.latest.width}px`;
      frame.style.height = `${interaction.latest.height}px`;
      frame.style.transform = '';
      frame.classList.remove('is-interacting', 'is-moving', 'is-resizing');
    }

    const next = interaction.latest;
    interactionRef.current = null;
    onChange(next);
  }

  useEffect(
    () => () => {
      const animationFrame = interactionRef.current?.animationFrame;
      if (animationFrame !== null && animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }
    },
    [],
  );

  function beginDrag(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    interactionRef.current = {
      kind: 'move',
      pointerId: event.pointerId,
      start: win,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - win.x,
      grabY: event.clientY - win.y,
      latest: win,
      animationFrame: null,
    };
    frameRef.current?.classList.add('is-interacting', 'is-moving');
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function drag(event: React.PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.kind !== 'move' || interaction.pointerId !== event.pointerId) {
      return;
    }
    scheduleInteraction(
      moveWindow(
        interaction.start,
        event.clientX,
        event.clientY,
        interaction.grabX,
        interaction.grabY,
      ),
    );
  }

  function resize(event: React.PointerEvent<HTMLButtonElement>) {
    const interaction = interactionRef.current;
    if (
      !interaction ||
      interaction.kind !== 'resize' ||
      interaction.pointerId !== event.pointerId
    ) {
      return;
    }
    scheduleInteraction(
      resizeWindow(
        interaction.start,
        event.clientX - interaction.startX,
        event.clientY - interaction.startY,
      ),
    );
  }

  return (
    <section
      ref={frameRef}
      className="iris-window"
      style={{ left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z }}
      onPointerDown={onFocus}
      aria-label={win.title}
    >
      <div
        className="window-titlebar"
        tabIndex={0}
        aria-label={`${win.title}. Use arrow keys to move; Shift and arrow keys to resize.`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const dx = event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0;
          const dy = event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0;
          onChange(event.shiftKey ? resizeWindow(win, dx, dy) : moveWindow(win, win.x + dx, win.y + dy, 0, 0));
        }}
        onPointerDown={beginDrag}
        onPointerMove={drag}
        onPointerUp={(event) => finishInteraction(event.pointerId)}
        onPointerCancel={(event) => finishInteraction(event.pointerId)}
        onLostPointerCapture={(event) => finishInteraction(event.pointerId)}
      >
        <div className="window-title">
          <span className="window-dot" />
          {win.title}
        </div>
        <button className="icon-button" aria-label={`Close ${win.title}`} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="window-content">
        <Suspense fallback={<p role="status">Loading window…</p>}>
        {win.objectType === 'welcome' ? (
          <WelcomeState />
        ) : win.objectType === 'agents' ? (
          <AgentsState />
        ) : win.objectType === 'projects' ? (
          <ProjectsState onOpenFlowStage={onOpenProject} />
        ) : win.objectType === 'github' ? (
          <GitHubState />
        ) : win.objectType === 'schedules' ? (
          <SchedulesState />
        ) : win.objectType === 'workspace' ? (
          <WorkspaceState />
        ) : win.objectType === 'models' ? (
          <ModelsState />
        ) : win.objectType === 'memory' ? (
          <MemoryState />
        ) : win.objectType === 'skills' ? (
          <SkillsState />
        ) : win.objectType === 'subtitles' ? (
          <SubtitlesState />
        ) : win.objectType === 'connections' ? (
          <McpState />
        ) : win.objectType === 'channels' ? (
          <ChannelsWindow />
        ) : win.objectType === 'settings' ? (
          <PermissionsState />
        ) : (
          <EmptyState type={win.objectType} />
        )}
        </Suspense>
      </div>
      <button
        className="resize-handle"
        aria-label={`Resize ${win.title}`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFocus();
          interactionRef.current = {
            kind: 'resize',
            pointerId: event.pointerId,
            start: win,
            startX: event.clientX,
            startY: event.clientY,
            grabX: 0,
            grabY: 0,
            latest: win,
            animationFrame: null,
          };
          frameRef.current?.classList.add('is-interacting', 'is-resizing');
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={resize}
        onPointerUp={(event) => finishInteraction(event.pointerId)}
        onPointerCancel={(event) => finishInteraction(event.pointerId)}
        onLostPointerCapture={(event) => finishInteraction(event.pointerId)}
      />
    </section>
  );
}