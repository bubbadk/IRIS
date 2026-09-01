import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildConstellation,
  type Constellation,
  type ConstellationNode,
  type MemoryRecord,
} from '@iris/memory';
import { contextPackRepository } from './persistence';

interface MemoryConstellationViewProps {
  records: MemoryRecord[];
  agentId: string | null;
  agentName?: string;
}

interface Star {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  bornMs: number;
  usageCount: number;
  phase: number;
  litUntil: number;
}

const POLL_MS = 2500;
const STAR_COLORS = {
  fresh: '#d9962e',
  mid: '#b0771f',
  old: '#5f7a94',
  glow: '#ffd98a',
  link: 'rgba(122, 106, 66, 0.45)',
  linkLit: 'rgba(255, 217, 138, 0.75)',
};

function ageColor(bornMs: number, newestMs: number, oldestMs: number): string {
  if (newestMs <= oldestMs) return STAR_COLORS.fresh;
  const age = (newestMs - bornMs) / Math.max(1, newestMs - oldestMs);
  return age < 0.25 ? STAR_COLORS.fresh : age < 0.6 ? STAR_COLORS.mid : STAR_COLORS.old;
}

/**
 * Memory Constellation: a living star-map of what the agent actually remembers.
 * Stars are real memory records, sized by how often retrieval selected them and
 * colored by age. Lines connect memories retrieved in the same turn. When a
 * turn retrieves memories, the selected stars light up in rank order — a live,
 * honest view of the retrieval engine at work. No simulated data: everything
 * comes from the persisted memory records and context packs.
 */
export function MemoryConstellationView({ records, agentId, agentName }: MemoryConstellationViewProps) {
  const [scopeAll, setScopeAll] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const starsRef = useRef<Map<string, Star>>(new Map());
  const sizeRef = useRef({ width: 0, height: 0 });
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const litUntilRef = useRef<Map<string, number>>(new Map());
  const activePromptRef = useRef<{ prompt: string; until: number } | null>(null);
  const seenTraceRef = useRef<string | null>(null);

  const [packs, setPacks] = useState<ContextPackList>([]);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [selected, setSelected] = useState<ConstellationNode | null>(null);
  const [glowPrompt, setGlowPrompt] = useState<string | null>(null);

  // Load context packs now and poll for new retrievals so the glow reacts
  // live while agents work. Polling (not events) keeps this decoupled from
  // the agent runtime. With an agent selected, retrievals are scoped to that
  // agent; with none, the whole workspace is shown.
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const scopeAllRef = useRef(scopeAll);
  scopeAllRef.current = scopeAll;
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const all = await contextPackRepository.listAll();
      const scoped =
        !scopeAllRef.current && agentIdRef.current
          ? all.filter((pack) => pack.agentId === agentIdRef.current)
          : all;
      if (!disposed) setPacks(scoped);
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const constellation: Constellation = useMemo(() => {
    if (scrubMs === null) return buildConstellation(records, packs);
    const scopedPacks = packs.filter((pack) => (Date.parse(pack.createdAt) || 0) <= scrubMs);
    const scopedRecords = records.filter((record) => (Date.parse(record.createdAt) || 0) <= scrubMs);
    return buildConstellation(scopedRecords, scopedPacks);
  }, [records, packs, scrubMs]);

  const timeRange = useMemo(() => {
    const times = records
      .map((record) => Date.parse(record.createdAt))
      .filter((value) => !Number.isNaN(value));
    if (!times.length) return { oldest: Date.now(), newest: Date.now() };
    return { oldest: Math.min(...times), newest: Math.max(...times, Date.now() - 1) };
  }, [records]);

  useEffect(() => {
    if (scrubMs === null) setScrubMs(timeRange.newest);
  }, [timeRange, scrubMs]);

  // New trace detection → schedule rank-order glow.
  useEffect(() => {
    if (!constellation.traces.length) return;
    const newest = constellation.traces[constellation.traces.length - 1];
    const traceKey = `${newest.turnId}:${newest.createdAt}`;
    if (seenTraceRef.current === traceKey) return;
    seenTraceRef.current = traceKey;
    const now = performance.now();
    newest.rankedIds.forEach((id, index) => {
      litUntilRef.current.set(id, now + 600 + index * 320 + 2600);
    });
    activePromptRef.current = { prompt: newest.prompt, until: now + 600 + newest.rankedIds.length * 320 + 2600 };
    setGlowPrompt(newest.prompt);
    const clearTimer = window.setTimeout(
      () => setGlowPrompt((current) => (current === newest.prompt ? null : current)),
      600 + newest.rankedIds.length * 320 + 2600,
    );
    return () => window.clearTimeout(clearTimer);
  }, [constellation]);

  // Keep stars in sync with the (possibly scrubbed) constellation.
  useEffect(() => {
    const stars = starsRef.current;
    const alive = new Set(constellation.nodes.map((node) => node.memoryId));
    for (const id of [...stars.keys()]) if (!alive.has(id)) stars.delete(id);

    const { width, height } = sizeRef.current;
    constellation.nodes.forEach((node, index) => {
      const existing = stars.get(node.memoryId);
      if (existing) {
        existing.radius = 4 + Math.min(10, node.usageCount * 1.8) + Math.min(3, node.content.length / 400);
        existing.usageCount = node.usageCount;
        return;
      }
      // Seed new stars on a golden-angle spiral so they never overlap at t=0.
      const golden = index * 2.399963;
      const radius = Math.min(width, height) * 0.42 * Math.sqrt((index + 1) / Math.max(1, constellation.nodes.length));
      stars.set(node.memoryId, {
        id: node.memoryId,
        x: width / 2 + Math.cos(golden) * radius,
        y: height / 2 + Math.sin(golden) * radius,
        vx: 0,
        vy: 0,
        radius: 4 + Math.min(10, node.usageCount * 1.8) + Math.min(3, node.content.length / 400),
        bornMs: Date.parse(node.createdAt) || 0,
        usageCount: node.usageCount,
        phase: Math.random() * Math.PI * 2,
        litUntil: 0,
      });
    });
  }, [constellation]);

  const draw = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { width, height } = sizeRef.current;
      if (!width || !height) return;

      ctx.clearRect(0, 0, width, height);

      // Gentle physics: repulsion, link springs, soft center pull, damping.
      const list = [...starsRef.current.values()];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 1) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            distSq = 5;
          }
          const force = 1400 / distSq;
          const dist = Math.sqrt(distSq);
          a.vx -= (dx / dist) * force;
          a.vy -= (dy / dist) * force;
          b.vx += (dx / dist) * force;
          b.vy += (dy / dist) * force;
        }
      }
      const byId = new Map(list.map((star) => [star.id, star]));
      for (const link of constellation.links) {
        const a = byId.get(link.fromId);
        const b = byId.get(link.toId);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const rest = 90 + 24 * Math.min(5, link.weight);
        const force = (dist - rest) * 0.004 * Math.min(3, link.weight);
        a.vx += (dx / dist) * force * dist * 0.02;
        a.vy += (dy / dist) * force * dist * 0.02;
        b.vx -= (dx / dist) * force * dist * 0.02;
        b.vy -= (dy / dist) * force * dist * 0.02;
      }
      for (const star of list) {
        star.vx += (width / 2 - star.x) * 0.0006;
        star.vy += (height / 2 - star.y) * 0.0006;
        star.vx *= 0.86;
        star.vy *= 0.86;
        star.x = Math.max(star.radius + 4, Math.min(width - star.radius - 4, star.x + star.vx));
        star.y = Math.max(star.radius + 4, Math.min(height - star.radius - 4, star.y + star.vy));
      }

      // Links first (under the stars).
      for (const link of constellation.links) {
        const a = byId.get(link.fromId);
        const b = byId.get(link.toId);
        if (!a || !b) continue;
        const lit = time < (litUntilRef.current.get(link.fromId) ?? 0)
          || time < (litUntilRef.current.get(link.toId) ?? 0);
        ctx.strokeStyle = lit ? STAR_COLORS.linkLit : STAR_COLORS.link;
        ctx.lineWidth = Math.min(3.5, 0.9 + link.weight * 0.6);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Stars.
      const newestMs = Math.max(...list.map((star) => star.bornMs), 1);
      const oldestMs = Math.min(...list.map((star) => star.bornMs), newestMs - 1);
      for (const star of list) {
        const twinkle = 0.85 + 0.15 * Math.sin(time / 900 + star.phase);
        const lit = time < (litUntilRef.current.get(star.id) ?? 0);
        const hover = hoverRef.current === star.id || selectedRef.current === star.id;

        if (lit) {
          const glowRadius = star.radius * (5 + 2 * Math.sin(time / 260 + star.phase));
          const gradient = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, glowRadius);
          gradient.addColorStop(0, 'rgba(255, 217, 138, 0.75)');
          gradient.addColorStop(1, 'rgba(255, 217, 138, 0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(star.x, star.y, glowRadius, 0, Math.PI * 2);
          ctx.fill();
        }

        if (!lit) {
          const halo = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.radius * 2.8);
          halo.addColorStop(0, 'rgba(217, 150, 46, 0.22)');
          halo.addColorStop(1, 'rgba(217, 150, 46, 0)');
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.radius * 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = star.usageCount === 0 && !lit ? 0.8 : 1;
        ctx.fillStyle = lit ? STAR_COLORS.glow : ageColor(star.bornMs, newestMs, oldestMs);
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius * (hover ? 1.35 : 1) * twinkle, 0, Math.PI * 2);
        ctx.fill();
        if (hover) {
          ctx.strokeStyle = 'rgba(255, 217, 138, 0.9)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.radius + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    },
    [constellation],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width: rect.width, height: rect.height };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let raf = 0;
    const loop = (time: number) => {
      draw(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [draw]);

  const pick = (event: React.MouseEvent<HTMLCanvasElement>): ConstellationNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: { id: string; dist: number } | null = null;
    for (const star of starsRef.current.values()) {
      const dist = Math.hypot(star.x - x, star.y - y);
      const threshold = Math.max(12, star.radius + 6);
      if (dist <= threshold && (!best || dist < best.dist)) {
        best = { id: star.id, dist };
      }
    }
    if (!best) return null;
    return constellation.nodes.find((node) => node.memoryId === best.id) ?? null;
  };

  const stats = {
    stars: constellation.nodes.length,
    links: constellation.links.length,
    retrievals: constellation.traces.length,
  };

  if (!records.length) {
    return (
      <div
        style={{
          border: '1px dashed var(--line)',
          borderRadius: '12px',
          padding: '28px 16px',
          textAlign: 'center',
          fontSize: '12px',
          color: 'var(--text-muted)',
        }}
      >
        No memories yet. The constellation draws itself from what your agents actually remember —
        save a memory, or let an agent run with memory access, and the stars appear here.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--ink)' }}>🌌 Memory Constellation</h3>
          {agentId && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className={`button ${scopeAll ? 'button-primary' : 'button-secondary'}`}
                style={{ fontSize: '11px', padding: '3px 10px' }}
                onClick={() => setScopeAll(true)}
              >
                All agents
              </button>
              <button
                type="button"
                className={`button ${!scopeAll ? 'button-primary' : 'button-secondary'}`}
                style={{ fontSize: '11px', padding: '3px 10px' }}
                onClick={() => setScopeAll(false)}
              >
                {agentName || 'Selected agent'}
              </button>
            </div>
          )}
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {stats.stars} memories · {stats.links} co-retrieval links · {stats.retrievals} recorded retrievals
        </span>
      </div>

      <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Every star is a real memory, sized by how often retrieval selects it. When an agent works,
        the memories it actually uses light up in rank order. Drag the timeline to watch the
        constellation grow.
      </div>

      <div
        ref={containerRef}
        style={{
          position: 'relative',
          height: 400,
          borderRadius: '14px',
          border: '1px solid var(--line)',
          background: 'radial-gradient(ellipse at 30% 20%, rgba(217,164,65,0.05), transparent 60%), linear-gradient(160deg, rgba(113,135,156,0.06), rgba(217,164,65,0.04))',
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: 'block', cursor: hoverRef.current ? 'pointer' : 'default' }}
          onMouseMove={(event) => {
            hoverRef.current = pick(event)?.memoryId ?? null;
          }}
          onMouseLeave={() => {
            hoverRef.current = null;
          }}
          onClick={(event) => {
            const node = pick(event);
            selectedRef.current = node?.memoryId ?? null;
            setSelected(node);
          }}
        />
        {glowPrompt && (
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: 12,
              right: 12,
              fontSize: '11px',
              color: '#b07d1f',
              background: 'rgba(255, 244, 219, 0.92)',
              border: '1px solid rgba(217, 164, 65, 0.5)',
              borderRadius: '8px',
              padding: '6px 10px',
              boxShadow: '0 4px 14px rgba(217, 164, 65, 0.18)',
            }}
          >
            ✦ Retrieving: {glowPrompt.length > 110 ? `${glowPrompt.slice(0, 110)}…` : glowPrompt}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: '11px', color: 'var(--text-muted)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#d9962e', display: 'inline-block' }} /> retrieved recently
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#5f7a94', display: 'inline-block', marginLeft: 10 }} /> older
          <span style={{ display: 'inline-block', width: 22, height: 0, borderTop: '2px solid rgba(122, 106, 66, 0.45)', marginLeft: 10 }} /> retrieved together
        </span>
        <span>Larger stars are retrieved more often. Click a star for its provenance.</span>
      </div>

      {stats.retrievals === 0 && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--panel)', border: '1px dashed var(--line)', borderRadius: '8px', padding: '8px 12px' }}>
          No recorded retrievals in this view yet. Run an agent with memory access on a prompt that matches your saved memories — the stars it uses will light up here, and stars retrieved together connect with lines.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {new Date(timeRange.oldest).toLocaleDateString()}
        </span>
        <input
          type="range"
          min={timeRange.oldest}
          max={timeRange.newest}
          value={scrubMs ?? timeRange.newest}
          onChange={(event) => setScrubMs(Number(event.target.value))}
          style={{ flex: 1, accentColor: '#d9a441' }}
          aria-label="Memory timeline"
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {scrubMs === null || scrubMs >= timeRange.newest ? 'today' : new Date(scrubMs).toLocaleDateString()}
        </span>
      </div>

      {selected && (
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: '12px',
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <strong style={{ fontSize: '12px', color: 'var(--ink)' }}>
              {selected.speaker} · {new Date(selected.createdAt).toLocaleString()}
            </strong>
            <button
              type="button"
              className="button button-secondary"
              style={{ fontSize: '11px', padding: '3px 10px' }}
              onClick={() => {
                selectedRef.current = null;
                setSelected(null);
              }}
            >
              ✕ Close
            </button>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--ink)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {selected.content}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Retrieved {selected.usageCount === 0 ? 'never so far' : `${selected.usageCount}× · last ${selected.lastUsedAt ? new Date(selected.lastUsedAt).toLocaleString() : ''}`}
          </div>
          {selected.retrievedBy.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {selected.retrievedBy.slice(-3).map((prompt, index) => (
                <div key={`${index}-${prompt.slice(0, 20)}`}>↳ {prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ContextPackList = Awaited<ReturnType<typeof contextPackRepository.listAll>>;
