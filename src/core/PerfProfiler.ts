/**
 * PerfProfiler — lightweight per-system frame timing.
 *
 * Usage:
 *   import { perf } from '@/core/PerfProfiler';
 *   perf.begin('updateAI');
 *   ...work...
 *   perf.end('updateAI');
 *
 * Toggle via window.__td.perf.enable() / .disable()
 * Dump a 60-frame summary with window.__td.perf.dump()
 */

interface Sample {
  total: number;        // accumulated ms
  calls: number;
  maxCall: number;      // single-call max ms
  startedAt: number;    // performance.now() marker
}

const samples = new Map<string, Sample>();
let enabled = false;
let frameTimer = 0;
let framesCollected = 0;
let lastFrameMark = 0;
let maxFrameGap = 0;

function getSample(name: string): Sample {
  let s = samples.get(name);
  if (!s) {
    s = { total: 0, calls: 0, maxCall: 0, startedAt: 0 };
    samples.set(name, s);
  }
  return s;
}

type Row = {
  name: string;
  avgMs: number;
  maxMs: number;
  callsPerFrame: number;
  shareOfFrame: string;
};

function shouldTraceSlow(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('perfTrace') ||
      window.localStorage.getItem('warzone_perf_trace') === '1';
  } catch {
    return false;
  }
}

function makeRows(wall: number, frames: number): Row[] {
  const rows: Row[] = [];
  const perFrameMs = wall / frames;

  samples.forEach((s, name) => {
    const avgMs = s.total / frames;
    rows.push({
      name,
      avgMs: +avgMs.toFixed(3),
      maxMs: +s.maxCall.toFixed(3),
      callsPerFrame: +(s.calls / frames).toFixed(2),
      shareOfFrame: `${((avgMs / perFrameMs) * 100).toFixed(1)}%`,
    });
  });
  rows.sort((a, b) => b.avgMs - a.avgMs);
  return rows;
}

function resetSamples(): void {
  samples.forEach((s) => { s.total = 0; s.calls = 0; s.maxCall = 0; s.startedAt = 0; });
  framesCollected = 0;
  frameTimer = performance.now();
  lastFrameMark = 0;
  maxFrameGap = 0;
}

export const perf = {
  enable(): void {
    enabled = true;
    samples.clear();
    framesCollected = 0;
    frameTimer = performance.now();
    lastFrameMark = 0;
    maxFrameGap = 0;
    console.info('[perf] profiler ON — call __td.perf.dump() to see results');
  },

  disable(): void {
    enabled = false;
    console.info('[perf] profiler OFF');
  },

  isEnabled(): boolean { return enabled; },

  begin(name: string): void {
    if (!enabled) return;
    getSample(name).startedAt = performance.now();
  },

  end(name: string): void {
    if (!enabled) return;
    const s = getSample(name);
    if (s.startedAt === 0) return;
    const dt = performance.now() - s.startedAt;
    s.total += dt;
    s.calls++;
    if (dt > s.maxCall) s.maxCall = dt;
    if (dt > 25 && shouldTraceSlow()) {
      console.warn(`[perf:slow] ${name} ${dt.toFixed(1)}ms`);
    }
    s.startedAt = 0;
  },

  /** Call once per frame; tracks frame count for averages. */
  markFrame(): void {
    if (!enabled) return;
    const now = performance.now();
    if (lastFrameMark > 0) {
      const gap = now - lastFrameMark;
      if (gap > maxFrameGap) maxFrameGap = gap;
      if (gap > 100 && shouldTraceSlow()) {
        console.warn(`[perf:frame] ${gap.toFixed(1)}ms since previous frame`);
      }
    }
    lastFrameMark = now;
    framesCollected++;
  },

  snapshot(): { frames: number; wallMs: number; fps: number; avgFrameMs: number; maxFrameGapMs: number; rows: Row[] } {
    const wall = performance.now() - frameTimer;
    const frames = Math.max(1, framesCollected);
    return {
      frames,
      wallMs: +wall.toFixed(1),
      fps: +(frames / (wall / 1000)).toFixed(1),
      avgFrameMs: +(wall / frames).toFixed(2),
      maxFrameGapMs: +maxFrameGap.toFixed(1),
      rows: makeRows(wall, frames),
    };
  },

  /** Print a table of accumulated samples. */
  dump(): void {
    const snap = this.snapshot();
    console.group(`[perf] ${snap.frames} frames in ${snap.wallMs.toFixed(0)}ms - ${snap.fps.toFixed(1)} FPS, ${snap.avgFrameMs.toFixed(2)}ms/frame, max gap ${snap.maxFrameGapMs.toFixed(1)}ms`);
    console.table(snap.rows);
    console.groupEnd();
    resetSamples();
    /*
    console.group(`[perf] ${frames} frames in ${wall.toFixed(0)}ms — ${fps} FPS, ${perFrameMs.toFixed(2)}ms/frame`);
    */
  },
};
