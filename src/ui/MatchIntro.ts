/**
 * MatchIntro — cinematic pre-match opening.
 *
 * Phases:
 *   1. map (0 – 2.0s)       — Map name slate + mode tag
 *   2. sweep (2.0 – 5.5s)   — Camera sweep over the arena
 *   3. rosters (5.5 – 7.5s) — BLUE vs RED team cards
 *   4. FIGHT (7.5 – 8.8s)   — Cinematic "FIGHT" slate (EXTRA IDEA #9)
 *   5. done                 — Hand control to the player
 *
 * Skipping:
 *   SPACE or ESC → end the intro immediately and start gameplay.
 *
 * Integration:
 *   playMatchIntro(opts)  → Promise that resolves when intro is done
 *   gameState._introActive = true blocks input while running
 *   body.intro-active class hides the HUD via the visibility gate in
 *     index.css
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { setViewmodelVisible } from '@/rendering/WeaponViewmodel';

export interface MatchIntroOptions {
  mapName: string;
  modeLabel: string;
  teamBlue: Array<{ name: string; level?: number; isPlayer?: boolean }>;
  teamRed:  Array<{ name: string; level?: number; isPlayer?: boolean }>;
  arena?: {
    cameraPath?: Array<{ pos: THREE.Vector3; lookAt: THREE.Vector3; t: number }>;
  };
  camera: THREE.PerspectiveCamera;
  onSkip?: () => void;
}

interface IntroState {
  active: boolean;
  skipRequested: boolean;
  startTime: number;
  phase: 'map' | 'sweep' | 'rosters' | 'fight' | 'done';
  opts: MatchIntroOptions | null;
  overlay: HTMLDivElement | null;
  cameraRestore: { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number } | null;
  keyListener: ((e: KeyboardEvent) => void) | null;
}

const introState: IntroState = {
  active: false,
  skipRequested: false,
  startTime: 0,
  phase: 'map',
  opts: null,
  overlay: null,
  cameraRestore: null,
  keyListener: null,
};

// ── Phase timings (seconds) ───────────────────────────────
// Rosters runs for 2s, then FIGHT slate for 1.3s before cutting to play.
const T_MAP_END     = 2.0;
const T_SWEEP_END   = 5.5;
const T_ROSTERS_END = 7.5;
const T_FIGHT_END   = 8.8;   // EXTRA IDEA #9: restored FIGHT slate

// ─────────────────────────────────────────────────────────────────────
//  OVERLAY DOM
// ─────────────────────────────────────────────────────────────────────

function createOverlay(opts: MatchIntroOptions): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.id = 'matchIntroOverlay';

  const rosterRow = (p: { name: string; level?: number; isPlayer?: boolean }) => `
    <div class="mi-player${p.isPlayer ? ' mi-player-you' : ''}">
      <div class="mi-player-lvl">${p.level ?? '—'}</div>
      <div class="mi-player-name">${p.name}</div>
    </div>
  `;

  overlay.innerHTML = `
    <div class="mi-vignette"></div>
    <div class="mi-fade"></div>
    <div class="mi-content">

      <div class="mi-phase-map" data-phase="map">
        <div class="mi-kicker">// DEPLOYMENT · APEX PROTOCOL</div>
        <div class="mi-mapname">${opts.mapName}</div>
        <div class="mi-modetag">${opts.modeLabel}</div>
        <div class="mi-hbar"></div>
      </div>

      <div class="mi-phase-rosters" data-phase="rosters">
        <div class="mi-roster mi-roster-blue">
          <div class="mi-roster-head">// BLUE TEAM</div>
          ${opts.teamBlue.map(rosterRow).join('')}
        </div>
        <div class="mi-vs">VS</div>
        <div class="mi-roster mi-roster-red">
          <div class="mi-roster-head">// RED TEAM</div>
          ${opts.teamRed.map(rosterRow).join('')}
        </div>
      </div>

      <div class="mi-phase-fight" data-phase="fight">
        <div class="mi-fight">FIGHT</div>
      </div>

    </div>
    <div class="mi-skip-hint">[SPACE] SKIP · [ESC] CUT TO GAMEPLAY</div>
  `;

  if (!document.getElementById('matchIntroStyle')) {
    const s = document.createElement('style');
    s.id = 'matchIntroStyle';
    s.textContent = `
      #matchIntroOverlay {
        position: fixed; inset: 0;
        z-index: 50;
        pointer-events: auto;
        font-family: var(--f-ui, 'Chakra Petch', sans-serif);
        color: var(--bone, #e9ecf1);
        overflow: hidden;
      }
      #matchIntroOverlay .mi-vignette {
        position: absolute; inset: 0;
        background: radial-gradient(circle at center, transparent 30%, rgba(0,0,0,0.85) 100%);
        pointer-events: none;
      }
      #matchIntroOverlay .mi-fade {
        position: absolute; inset: 0;
        background: black;
        transition: opacity 0.25s ease;
        opacity: 1;
        pointer-events: none;
      }
      #matchIntroOverlay .mi-fade.hide { opacity: 0; pointer-events: none; }
      #matchIntroOverlay .mi-content {
        position: absolute; inset: 0;
        display: grid; place-items: center;
      }

      /* PHASE 1: MAP SLATE */
      #matchIntroOverlay .mi-phase-map {
        text-align: center;
        opacity: 0;
        transition: opacity 0.4s, transform 0.4s;
        transform: translateY(10px);
      }
      #matchIntroOverlay .mi-phase-map.show { opacity: 1; transform: translateY(0); }
      #matchIntroOverlay .mi-kicker {
        font-family: var(--f-num, 'JetBrains Mono', monospace);
        font-size: 12px; font-weight: 500;
        letter-spacing: .5em;
        color: var(--signal, #ff8c1a);
        margin-bottom: 22px;
      }
      #matchIntroOverlay .mi-mapname {
        font-family: var(--f-display, 'Archivo Black', sans-serif);
        font-size: 96px; font-weight: 400;
        letter-spacing: -.02em;
        color: var(--bone, #e9ecf1);
        text-shadow: 0 0 40px rgba(255, 140, 26, 0.25);
      }
      #matchIntroOverlay .mi-modetag {
        margin-top: 10px;
        font-family: var(--f-tactical, 'Syncopate', sans-serif);
        font-size: 18px; font-weight: 700;
        letter-spacing: .6em;
        color: var(--bone-dim, #b5bcc8);
        padding-left: .6em;
      }
      #matchIntroOverlay .mi-hbar {
        width: 340px; height: 1px; margin: 24px auto 0;
        background: linear-gradient(90deg, transparent, var(--signal, #ff8c1a), transparent);
      }

      /* PHASE 3: ROSTERS */
      #matchIntroOverlay .mi-phase-rosters {
        display: none;
        grid-template-columns: 1fr auto 1fr;
        gap: 40px;
        align-items: stretch;
        max-width: 820px; width: 85%;
      }
      #matchIntroOverlay .mi-phase-rosters.show {
        display: grid;
        animation: miRosterIn 0.4s ease-out;
      }
      @keyframes miRosterIn {
        from { opacity: 0; transform: translateY(20px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #matchIntroOverlay .mi-roster {
        background: rgba(6, 7, 11, 0.92);
        padding: 16px 20px;
        border-top: 3px solid;
        min-height: 240px;
        backdrop-filter: blur(8px);
      }
      #matchIntroOverlay .mi-roster-blue { border-top-color: var(--cyan, #39f0ff); }
      #matchIntroOverlay .mi-roster-red  { border-top-color: var(--hazard, #ff3d2e); text-align: right; }
      #matchIntroOverlay .mi-roster-head {
        font-family: var(--f-num, 'JetBrains Mono', monospace);
        font-size: 11px; font-weight: 500;
        letter-spacing: 0.35em;
        margin-bottom: 16px;
      }
      #matchIntroOverlay .mi-roster-blue .mi-roster-head { color: var(--cyan, #39f0ff); }
      #matchIntroOverlay .mi-roster-red  .mi-roster-head { color: var(--hazard, #ff3d2e); }
      #matchIntroOverlay .mi-player {
        display: flex; align-items: center; gap: 10px;
        padding: 5px 0;
        border-bottom: 1px solid rgba(233, 236, 241, 0.05);
      }
      #matchIntroOverlay .mi-roster-red .mi-player { flex-direction: row-reverse; }
      #matchIntroOverlay .mi-player-lvl {
        font-family: var(--f-num, 'JetBrains Mono', monospace);
        font-size: 11px; font-weight: 700;
        background: rgba(255, 255, 255, 0.05);
        padding: 3px 8px; min-width: 28px;
        text-align: center;
        color: var(--signal, #ff8c1a);
      }
      #matchIntroOverlay .mi-player-name {
        font-family: var(--f-tactical, 'Syncopate', sans-serif);
        font-size: 13px;
        letter-spacing: .15em;
      }
      #matchIntroOverlay .mi-player-you {
        background: linear-gradient(90deg, rgba(255, 140, 26, 0.15), transparent);
      }
      #matchIntroOverlay .mi-player-you .mi-player-name {
        color: var(--signal, #ff8c1a); font-weight: 700;
      }
      #matchIntroOverlay .mi-roster-red .mi-player-you {
        background: linear-gradient(-90deg, rgba(255, 140, 26, 0.15), transparent);
      }
      #matchIntroOverlay .mi-vs {
        font-family: var(--f-display, 'Archivo Black', sans-serif);
        font-size: 44px; font-weight: 400;
        align-self: center;
        letter-spacing: .08em;
        color: var(--signal, #ff8c1a);
        text-shadow: 0 0 16px rgba(255, 140, 26, 0.4);
      }

      /* PHASE 4: FIGHT (restored — EXTRA IDEA #9) */
      #matchIntroOverlay .mi-phase-fight {
        display: none; text-align: center;
      }
      #matchIntroOverlay .mi-phase-fight.show {
        display: block;
        animation: miFightIn 0.35s var(--ease-snap, cubic-bezier(.2,.9,.2,1.1));
      }
      @keyframes miFightIn {
        0%   { transform: scale(0.4); opacity: 0; letter-spacing: .5em; }
        60%  { transform: scale(1.25); opacity: 1; letter-spacing: -.01em; }
        100% { transform: scale(1);   opacity: 1; letter-spacing: -.02em; }
      }
      #matchIntroOverlay .mi-fight {
        font-family: var(--f-display, 'Archivo Black', sans-serif);
        font-size: 160px; font-weight: 400;
        letter-spacing: -.02em;
        color: #fff;
        background: linear-gradient(90deg,
            var(--hazard, #ff3d2e) 0%,
            var(--signal, #ff8c1a) 45%,
            var(--signal-hot, #ffa73a) 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        text-shadow: 0 0 40px rgba(255, 61, 46, 0.5);
      }

      /* Skip hint */
      #matchIntroOverlay .mi-skip-hint {
        position: absolute; bottom: 24px; left: 50%;
        transform: translateX(-50%);
        font-family: var(--f-num, 'JetBrains Mono', monospace);
        font-size: 10px; letter-spacing: 0.3em;
        color: rgba(233, 236, 241, 0.4);
      }

      /* Hide all phase content during sweep — camera is the show */
      #matchIntroOverlay.sweep .mi-content > div { display: none; }
      #matchIntroOverlay.sweep .mi-skip-hint { opacity: 0.6; }
    `;
    document.head.appendChild(s);
  }

  document.body.appendChild(overlay);
  return overlay;
}

// ─────────────────────────────────────────────────────────────────────
//  CAMERA SWEEP
// ─────────────────────────────────────────────────────────────────────

function defaultCameraPath(): Array<{ pos: THREE.Vector3; lookAt: THREE.Vector3; t: number }> {
  return [
    { pos: new THREE.Vector3(-30, 15, 30), lookAt: new THREE.Vector3(0, 2, 0), t: 0 },
    { pos: new THREE.Vector3(20, 22, 25),  lookAt: new THREE.Vector3(0, 2, 0), t: 0.4 },
    { pos: new THREE.Vector3(30, 12, -10), lookAt: new THREE.Vector3(0, 2, 0), t: 0.75 },
    { pos: new THREE.Vector3(5, 6, -15),   lookAt: new THREE.Vector3(0, 1.5, 0), t: 1 },
  ];
}

function interpolatePath(
  path: Array<{ pos: THREE.Vector3; lookAt: THREE.Vector3; t: number }>,
  t: number,
): { pos: THREE.Vector3; lookAt: THREE.Vector3 } {
  if (path.length === 0) return { pos: new THREE.Vector3(), lookAt: new THREE.Vector3() };
  if (t <= 0) return { pos: path[0].pos.clone(), lookAt: path[0].lookAt.clone() };
  if (t >= 1) {
    const last = path[path.length - 1];
    return { pos: last.pos.clone(), lookAt: last.lookAt.clone() };
  }
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    if (t >= a.t && t <= b.t) {
      const segT = (t - a.t) / (b.t - a.t);
      const eased = segT < 0.5 ? 2 * segT * segT : 1 - Math.pow(-2 * segT + 2, 2) / 2;
      return {
        pos:    a.pos.clone().lerp(b.pos, eased),
        lookAt: a.lookAt.clone().lerp(b.lookAt, eased),
      };
    }
  }
  return { pos: path[0].pos.clone(), lookAt: path[0].lookAt.clone() };
}

// ─────────────────────────────────────────────────────────────────────
//  MAIN API
// ─────────────────────────────────────────────────────────────────────

export function playMatchIntro(opts: MatchIntroOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    if (introState.active) { resolve(); return; }

    introState.active = true;
    introState.skipRequested = false;
    introState.startTime = performance.now() / 1000;
    introState.phase = 'map';
    introState.opts = opts;
    introState.overlay = createOverlay(opts);

    introState.cameraRestore = {
      pos:  opts.camera.position.clone(),
      quat: opts.camera.quaternion.clone(),
      fov:  opts.camera.fov,
    };

    gameState._introActive = true;

    // Hide HUD + viewmodel during the intro (body.intro-active rule in index.css).
    document.body.classList.add('intro-active');
    try { setViewmodelVisible(false); } catch { /* viewmodel may not be initialized yet */ }

    // Fade in the overlay and trigger map phase.
    requestAnimationFrame(() => {
      const fade = introState.overlay!.querySelector('.mi-fade') as HTMLElement;
      fade.classList.add('hide');
      const mapEl = introState.overlay!.querySelector('.mi-phase-map') as HTMLElement;
      mapEl.classList.add('show');
    });

    // Deployment sound stub
    import('@/audio/SoundHooks').then(s => {
      try { (s as any).playObjective?.() ?? (s as any).playAlert?.(); } catch { /* */ }
    }).catch(() => { /* */ });

    // Skip listener — SPACE or ESC ends the intro immediately.
    const keyListener = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Escape') {
        introState.skipRequested = true;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', keyListener);
    introState.keyListener = keyListener;

    let last = performance.now() / 1000;
    function tick() {
      if (!introState.active) return;
      const now = performance.now() / 1000;
      const dt  = now - last;
      last = now;

      const elapsed = now - introState.startTime;
      stepIntro(elapsed, dt);

      if (introState.phase === 'done') {
        cleanup();
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
}

function stepIntro(elapsed: number, _dt: number): void {
  if (!introState.opts || !introState.overlay) return;

  // Skip → jump to done.
  if (introState.skipRequested) {
    introState.skipRequested = false;
    introState.opts.onSkip?.();
    introState.phase = 'done';
    return;
  }

  const opts     = introState.opts;
  const overlay  = introState.overlay;
  const mapEl    = overlay.querySelector('.mi-phase-map')     as HTMLElement;
  const rosterEl = overlay.querySelector('.mi-phase-rosters') as HTMLElement;
  const fightEl  = overlay.querySelector('.mi-phase-fight')   as HTMLElement;

  if (elapsed < T_MAP_END) {
    introState.phase = 'map';
    overlay.classList.remove('sweep');

  } else if (elapsed < T_SWEEP_END) {
    if (introState.phase !== 'sweep') {
      introState.phase = 'sweep';
      mapEl.classList.remove('show');
      overlay.classList.add('sweep');
    }
    const path = opts.arena?.cameraPath ?? defaultCameraPath();
    const t = (elapsed - T_MAP_END) / (T_SWEEP_END - T_MAP_END);
    const sample = interpolatePath(path, t);
    opts.camera.position.copy(sample.pos);
    opts.camera.lookAt(sample.lookAt.x, sample.lookAt.y, sample.lookAt.z);

  } else if (elapsed < T_ROSTERS_END) {
    if (introState.phase !== 'rosters') {
      introState.phase = 'rosters';
      overlay.classList.remove('sweep');
      rosterEl.classList.add('show');
    }

  } else if (elapsed < T_FIGHT_END) {
    // EXTRA IDEA #9 — FIGHT slate (restored).
    if (introState.phase !== 'fight') {
      introState.phase = 'fight';
      rosterEl.classList.remove('show');
      fightEl.classList.add('show');
    }

  } else {
    introState.phase = 'done';
  }
}

function cleanup(): void {
  const opts = introState.opts;
  if (opts && introState.cameraRestore) {
    opts.camera.position.copy(introState.cameraRestore.pos);
    opts.camera.quaternion.copy(introState.cameraRestore.quat);
    opts.camera.fov = introState.cameraRestore.fov;
    opts.camera.updateProjectionMatrix();
  }
  introState.overlay?.remove();
  introState.overlay = null;
  if (introState.keyListener) {
    window.removeEventListener('keydown', introState.keyListener);
    introState.keyListener = null;
  }
  introState.active = false;
  introState.cameraRestore = null;
  introState.opts = null;
  gameState._introActive = false;

  document.body.classList.remove('intro-active');
  try { setViewmodelVisible(true); } catch { /* non-fatal */ }
}

export function isIntroActive(): boolean { return introState.active; }
export function skipIntro(): void { introState.skipRequested = true; }
