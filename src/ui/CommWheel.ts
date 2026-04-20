/**
 * PingSystem — radial comm wheel + tactical world pings.
 *
 * Replaces whatever ad-hoc ping support exists with:
 *   - Tap Q: contextual ping (looks at what you're aiming at, pings appropriately)
 *     - Enemy in crosshair → "Enemy!" ping + red diamond
 *     - Objective/zone in crosshair → "Capture here!"
 *     - Loot/item → "Item here"
 *     - Flat ground → "Going here" (blue chevron)
 *   - Hold Q: radial wheel with 8 options
 *     - Enemy / Attacking / Defending / Need help / Retreat / On me / Nice / Sorry
 *   - Pings attach to the world (stable screen position) with distance label
 *   - Auto-expire after 8 seconds
 *
 * Pings are visible to whole team. Bots respond to "On me" / "Attacking" /
 * "Defending" by adjusting goal weights (optional — hook in AIController).
 *
 * Design:
 *   - Each ping = world position + screen-space DOM marker (CSS)
 *   - Uses camera.projectVector to compute screen position each frame
 *   - Clipped to viewport edges with edge-arrow when off-screen
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';

export type PingKind =
  | 'enemy' | 'attacking' | 'defending' | 'help' | 'retreat'
  | 'onme' | 'nice' | 'sorry' | 'going' | 'objective' | 'loot';

interface PingDef {
  label: string;
  color: string;
  icon: string;       // unicode or single character
  voiceLine?: string;
}

const PINGS: Record<PingKind, PingDef> = {
  enemy:     { label: 'ENEMY',         color: '#ff3d2e', icon: '✕', voiceLine: 'Enemy spotted!' },
  attacking: { label: 'ATTACKING',     color: '#ff8c1a', icon: '▲', voiceLine: 'Attacking!' },
  defending: { label: 'DEFENDING',     color: '#39f0ff', icon: '◆', voiceLine: 'Defending!' },
  help:      { label: 'NEED HELP',     color: '#ff3d2e', icon: '!', voiceLine: 'Need backup!' },
  retreat:   { label: 'RETREAT',       color: '#c27bff', icon: '⇆', voiceLine: 'Falling back!' },
  onme:      { label: 'ON ME',         color: '#b8ff3d', icon: '●', voiceLine: 'Rally on me!' },
  nice:      { label: 'NICE',          color: '#ff8c1a', icon: '✓' },
  sorry:     { label: 'SORRY',         color: '#6d7689', icon: '—' },
  going:     { label: 'GOING HERE',    color: '#39f0ff', icon: '↑' },
  objective: { label: 'OBJECTIVE',     color: '#ff8c1a', icon: '⯁' },
  loot:      { label: 'LOOT',          color: '#b8ff3d', icon: '♦' },
};

interface ActivePing {
  kind: PingKind;
  position: THREE.Vector3;
  team: 'blue' | 'red' | null;
  createdAt: number;
  lifetimeSec: number;
  fromAgentId: string;     // who placed it (for bot responses)
  domEl: HTMLDivElement;
}

// ─────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────

interface PingSystemState {
  pings: ActivePing[];
  wheelActive: boolean;
  wheelX: number; wheelY: number;
  wheelSelection: PingKind | null;
  container: HTMLDivElement | null;
  wheelContainer: HTMLDivElement | null;
  holdStart: number;
  camera: THREE.Camera | null;
  raycaster: THREE.Raycaster;
}

const state: PingSystemState = {
  pings: [],
  wheelActive: false,
  wheelX: 0, wheelY: 0,
  wheelSelection: null,
  container: null,
  wheelContainer: null,
  holdStart: 0,
  camera: null,
  raycaster: new THREE.Raycaster(),
};

const PING_LIFETIME_SEC = 8;
const WHEEL_HOLD_THRESHOLD_MS = 180;

// ─────────────────────────────────────────────────────────────────────
//  DOM SETUP
// ─────────────────────────────────────────────────────────────────────

function ensureContainer(): HTMLDivElement {
  if (state.container) return state.container;
  state.container = document.createElement('div');
  state.container.id = 'pingContainer';
  document.body.appendChild(state.container);

  if (!document.getElementById('pingContainerStyle')) {
    const s = document.createElement('style');
    s.id = 'pingContainerStyle';
    s.textContent = `
      #pingContainer {
        position: fixed; inset: 0;
        pointer-events: none;
        z-index: 7;
      }
      .ping-marker {
        position: absolute;
        transform: translate(-50%, -50%);
        font-family: var(--mono-font);
        animation: pingPop 0.3s var(--ease-out-expo);
      }
      @keyframes pingPop {
        from { transform: translate(-50%, -50%) scale(0.3); opacity: 0; }
        to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      }
      .ping-marker .pm-dot {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 3px 10px;
        background: var(--panel-dense);
        border: 1px solid;
        border-left-width: 2px;
        font-size: 11px; font-weight: 700;
        letter-spacing: 0.2em;
        white-space: nowrap;
        backdrop-filter: blur(8px);
      }
      .ping-marker .pm-icon {
        font-size: 13px; font-weight: 900;
        text-shadow: 0 0 6px currentColor;
      }
      .ping-marker .pm-dist {
        font-size: 9px; color: var(--text-dim); opacity: 0.8;
        font-family: var(--mono-font); letter-spacing: 0.1em;
      }
      .ping-marker.fading { animation: pingFade 0.4s forwards; }
      @keyframes pingFade {
        to { opacity: 0; transform: translate(-50%, -50%) scale(0.7); }
      }
    `;
    document.head.appendChild(s);
  }

  return state.container;
}

function ensureWheelContainer(): HTMLDivElement {
  if (state.wheelContainer) return state.wheelContainer;
  state.wheelContainer = document.createElement('div');
  state.wheelContainer.id = 'pingWheel';
  document.body.appendChild(state.wheelContainer);

  if (!document.getElementById('pingWheelStyle')) {
    const s = document.createElement('style');
    s.id = 'pingWheelStyle';
    s.textContent = `
      #pingWheel {
        position: fixed; inset: 0;
        pointer-events: none;
        z-index: 12;
        display: none;
      }
      #pingWheel.active { display: block; }
      .pw-bg {
        position: absolute; inset: 0;
        background: radial-gradient(circle at center, rgba(6,7,11,0.55) 0%, rgba(6,7,11,0.72) 60%);
        backdrop-filter: blur(4px) brightness(0.6);
      }
      .pw-center {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: 320px; height: 320px;
      }
      .pw-slot {
        position: absolute; left: 50%; top: 50%;
        width: 80px; height: 80px;
        transform-origin: center;
        display: flex; align-items: center; justify-content: center;
        flex-direction: column;
        background: var(--panel-dense);
        border: 1px solid var(--hairline-strong);
        font-family: var(--mono-font);
        color: var(--bone);
        transition: transform 0.12s var(--ease-out-expo), background 0.12s, border 0.12s;
      }
      .pw-slot.hover {
        background: var(--steel-800);
        border-color: var(--ping-color, var(--signal));
        transform: scale(1.15) translate(var(--pw-dx), var(--pw-dy));
        box-shadow: 0 0 16px rgba(255,140,26,0.25);
      }
      .pw-slot .pw-ic {
        font-size: 18px; font-weight: 900;
        color: var(--ping-color, var(--signal));
        text-shadow: 0 0 8px currentColor;
      }
      .pw-slot .pw-lb {
        font-family: var(--mono-font);
        font-size: 8px; letter-spacing: 0.2em;
        color: var(--text-dim);
        margin-top: 4px;
        text-align: center;
      }
      .pw-title {
        position: absolute; left: 50%; top: calc(50% - 200px);
        transform: translateX(-50%);
        font-family: var(--tactical-font);
        font-size: 11px; font-weight: 700;
        letter-spacing: 0.4em;
        color: var(--signal);
        text-shadow: 0 0 8px var(--signal-glow);
      }
      .pw-center-dot {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: 6px; height: 6px;
        background: var(--signal);
        box-shadow: 0 0 8px var(--signal-glow);
      }
    `;
    document.head.appendChild(s);
  }

  return state.wheelContainer;
}

// ─────────────────────────────────────────────────────────────────────
//  WORLD RAYCAST — figure out WHAT the player is aiming at
// ─────────────────────────────────────────────────────────────────────

function raycastForPing(camera: THREE.Camera): {
  pos: THREE.Vector3;
  kind: 'enemy' | 'flat' | 'objective' | 'loot';
  dist: number;
} {
  state.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const origin = state.raycaster.ray.origin;
  const dir = state.raycaster.ray.direction;

  // 1. Check for enemy agents along ray (sphere test)
  const agents = gameState.agents ?? [];
  const playerTeam = gameState.player?.team;
  let bestEnemy: any = null;
  let bestEnemyDist = Infinity;

  for (const a of agents) {
    if (!a || a.hp <= 0 || !a.renderComponent) continue;
    if (a.team === playerTeam) continue;
    const toAgent = new THREE.Vector3().subVectors(a.renderComponent.position, origin);
    const proj = toAgent.dot(dir);
    if (proj < 0 || proj > 100) continue;
    const perpDist = toAgent.length() * Math.sin(Math.acos(Math.max(-1, Math.min(1, proj / toAgent.length()))));
    if (perpDist < 2 && proj < bestEnemyDist) {
      bestEnemyDist = proj;
      bestEnemy = a;
    }
  }

  if (bestEnemy) {
    return {
      pos: bestEnemy.renderComponent.position.clone(),
      kind: 'enemy',
      dist: bestEnemyDist,
    };
  }

  // 2. Check for objective zones (Domination/Hardpoint)
  const domState = (gameState as any)._domState;
  if (domState?.zones) {
    for (const z of domState.zones) {
      const toZone = new THREE.Vector3().subVectors(z.position, origin);
      const proj = toZone.dot(dir);
      if (proj < 0 || proj > 80) continue;
      const closestOnRay = origin.clone().addScaledVector(dir, proj);
      if (closestOnRay.distanceTo(z.position) < z.radius + 2) {
        return { pos: z.position.clone(), kind: 'objective', dist: proj };
      }
    }
  }

  // 3. Flat ground — raycast against a horizontal plane at y=0
  if (Math.abs(dir.y) > 0.01) {
    const t = -origin.y / dir.y;
    if (t > 0 && t < 200) {
      const hitPos = origin.clone().addScaledVector(dir, t);
      return { pos: hitPos, kind: 'flat', dist: t };
    }
  }

  // Fallback — 30m ahead
  return {
    pos: origin.clone().addScaledVector(dir, 30),
    kind: 'flat',
    dist: 30,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  PING LIFECYCLE
// ─────────────────────────────────────────────────────────────────────

export function placePing(
  kind: PingKind,
  position: THREE.Vector3,
  team: 'blue' | 'red' | null,
  fromAgentId: string = 'player',
): ActivePing {
  const container = ensureContainer();
  const def = PINGS[kind];

  const domEl = document.createElement('div');
  domEl.className = `ping-marker ${team ? `team-${team}` : ''}`;
  domEl.style.setProperty('color', def.color);
  domEl.innerHTML = `
    <div class="pm-dot" style="border-color:${def.color};color:${def.color};">
      <span class="pm-icon">${def.icon}</span>
      <span>${def.label}</span>
      <span class="pm-dist" id="dist"></span>
    </div>
  `;
  container.appendChild(domEl);

  const ping: ActivePing = {
    kind, position: position.clone(), team,
    createdAt: performance.now() / 1000,
    lifetimeSec: PING_LIFETIME_SEC,
    fromAgentId, domEl,
  };
  state.pings.push(ping);

  // Play ping sound
  import('@/audio/SoundHooks').then(s => {
    try { (s as any).playObjective?.() ?? (s as any).playAlert?.(); } catch { /* */ }
  }).catch(() => { /* */ });

  // Speak voice line if defined (for player pings only)
  if (def.voiceLine && fromAgentId === 'player') {
    try {
      const u = new SpeechSynthesisUtterance(def.voiceLine);
      u.rate = 1.1; u.pitch = 1; u.volume = 0.5;
      window.speechSynthesis?.speak(u);
    } catch { /* */ }
  }

  return ping;
}

function expirePing(p: ActivePing): void {
  p.domEl.classList.add('fading');
  setTimeout(() => p.domEl.remove(), 400);
}

// ─────────────────────────────────────────────────────────────────────
//  PER-FRAME UPDATE
// ─────────────────────────────────────────────────────────────────────

const _tmpScreen = new THREE.Vector3();

export function updatePingSystem(dt: number, camera: THREE.PerspectiveCamera): void {
  state.camera = camera;
  const now = performance.now() / 1000;
  const playerPos = gameState.player?.renderComponent?.position;

  // Update each ping's screen position
  for (let i = state.pings.length - 1; i >= 0; i--) {
    const p = state.pings[i];
    const age = now - p.createdAt;
    if (age >= p.lifetimeSec) {
      expirePing(p);
      state.pings.splice(i, 1);
      continue;
    }

    _tmpScreen.copy(p.position);
    _tmpScreen.project(camera);
    // Behind camera?
    if (_tmpScreen.z > 1) {
      p.domEl.style.display = 'none';
      continue;
    }
    p.domEl.style.display = 'block';

    const x = (_tmpScreen.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_tmpScreen.y * 0.5 + 0.5) * window.innerHeight;

    // Clamp to viewport (with 20px margin) — show edge arrow if off
    const marginX = 40, marginY = 40;
    const cx = Math.max(marginX, Math.min(window.innerWidth - marginX, x));
    const cy = Math.max(marginY, Math.min(window.innerHeight - marginY, y));
    const offScreen = cx !== x || cy !== y;

    p.domEl.style.left = `${cx}px`;
    p.domEl.style.top = `${cy}px`;
    p.domEl.style.opacity = String(offScreen ? 0.7 : Math.max(0.4, 1 - age / p.lifetimeSec));

    // Distance
    if (playerPos) {
      const dist = playerPos.distanceTo(p.position);
      const distEl = p.domEl.querySelector('#dist') as HTMLElement | null;
      if (distEl) distEl.textContent = `${Math.round(dist)}m`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
//  WHEEL UI
// ─────────────────────────────────────────────────────────────────────

const WHEEL_ORDER: PingKind[] = ['enemy', 'attacking', 'defending', 'help', 'retreat', 'onme', 'nice', 'sorry'];

function showWheel(): void {
  const wc = ensureWheelContainer();
  wc.innerHTML = `
    <div class="pw-bg"></div>
    <div class="pw-title">COMM WHEEL — Release to Ping</div>
    <div class="pw-center">
      <div class="pw-center-dot"></div>
      ${WHEEL_ORDER.map((k, i) => {
        const angle = (i / WHEEL_ORDER.length) * Math.PI * 2 - Math.PI / 2;
        const r = 110;
        const dx = Math.cos(angle) * r;
        const dy = Math.sin(angle) * r;
        const def = PINGS[k];
        return `<div class="pw-slot" data-kind="${k}" style="transform: translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)); --pw-dx: 0px; --pw-dy: 0px; --ping-color: ${def.color};">
          <div class="pw-ic">${def.icon}</div>
          <div class="pw-lb">${def.label}</div>
        </div>`;
      }).join('')}
    </div>
  `;
  wc.classList.add('active');
  state.wheelActive = true;
  state.wheelSelection = null;

  // Capture mouse for selection
  document.body.style.cursor = 'none';
}

function updateWheelSelection(): void {
  if (!state.wheelActive || !state.wheelContainer) return;

  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const dx = state.wheelX - cx;
  const dy = state.wheelY - cy;
  const dist = Math.hypot(dx, dy);

  if (dist < 30) {
    state.wheelSelection = null;
    state.wheelContainer.querySelectorAll('.pw-slot').forEach(el => el.classList.remove('hover'));
    return;
  }

  const angle = Math.atan2(dy, dx) + Math.PI / 2;
  const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
  const slotIndex = Math.floor((normalized / (Math.PI * 2)) * WHEEL_ORDER.length + 0.5) % WHEEL_ORDER.length;
  state.wheelSelection = WHEEL_ORDER[slotIndex];

  state.wheelContainer.querySelectorAll('.pw-slot').forEach(el => {
    const k = el.getAttribute('data-kind');
    if (k === state.wheelSelection) el.classList.add('hover');
    else el.classList.remove('hover');
  });
}

function hideWheel(): PingKind | null {
  state.wheelActive = false;
  document.body.style.cursor = '';
  if (state.wheelContainer) {
    state.wheelContainer.classList.remove('active');
    state.wheelContainer.innerHTML = '';
  }
  return state.wheelSelection;
}

// ─────────────────────────────────────────────────────────────────────
//  INPUT WIRING
// ─────────────────────────────────────────────────────────────────────

export function initPingSystem(): void {
  ensureContainer();
  ensureWheelContainer();

  // Track mouse for wheel selection
  window.addEventListener('mousemove', (e) => {
    state.wheelX = e.clientX;
    state.wheelY = e.clientY;
    if (state.wheelActive) updateWheelSelection();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyQ' && !e.repeat && !state.wheelActive) {
      state.holdStart = performance.now();
      // Delay wheel until threshold
      setTimeout(() => {
        if (state.holdStart > 0 && !state.wheelActive &&
            performance.now() - state.holdStart >= WHEEL_HOLD_THRESHOLD_MS) {
          showWheel();
          updateWheelSelection();
        }
      }, WHEEL_HOLD_THRESHOLD_MS);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'KeyQ') return;
    const camera = state.camera as THREE.PerspectiveCamera | null;
    const heldMs = performance.now() - state.holdStart;
    state.holdStart = 0;

    if (state.wheelActive) {
      // Wheel mode — use selection
      const selected = hideWheel();
      if (selected && camera) {
        const { pos } = raycastForPing(camera);
        placePing(selected, pos, gameState.player?.team != null ? (gameState.player.team === 0 ? 'blue' : 'red') : null);
      }
    } else if (heldMs < WHEEL_HOLD_THRESHOLD_MS && camera) {
      // Quick tap — contextual ping
      const hit = raycastForPing(camera);
      let kind: PingKind = 'going';
      if (hit.kind === 'enemy') kind = 'enemy';
      else if (hit.kind === 'objective') kind = 'objective';
      else if (hit.kind === 'loot') kind = 'loot';
      placePing(kind, hit.pos, gameState.player?.team != null ? (gameState.player.team === 0 ? 'blue' : 'red') : null);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
//  PUBLIC
// ─────────────────────────────────────────────────────────────────────

export function getActivePings(): ReadonlyArray<ActivePing> {
  return state.pings;
}

export function clearAllPings(): void {
  for (const p of state.pings) p.domEl.remove();
  state.pings.length = 0;
}