import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { playMedalSound } from '@/audio/SoundHooks';

/**
 * CommWheel — radial ping menu + world-space waypoint markers.
 *
 * APEX PROTOCOL spec §10 item 5:
 *   "Port the inline-injected CommWheel styles into the stylesheet
 *    using the amber/cyan palette and corner-bracket language."
 *
 * Change from the prior version: the ~300-line `<style>` block that
 * was injected at runtime has been REMOVED.  All .pw-*, .ping-dot,
 * .ping-label, .compass-ping-pip styles now live in index.css where
 * they can be themed consistently with the rest of the APEX system.
 *
 * This file is now pure behavior: DOM structure + input handling +
 * world→screen projection.
 *
 * Public API preserved:
 *   initPingSystem()         — wires keybinds & container
 *   updatePingSystem()       — per-frame world→screen projection
 *   placePing(worldPos, id)  — drop a ping at a location
 *   getActivePings()         — for minimap integration
 *   clearAllPings()          — reset on match end
 */

export type PingType = 'here' | 'enemy' | 'defend' | 'attack' | 'danger' | 'looking';

interface PingTypeDef {
  id:    PingType;
  label: string;
  icon:  string;        // unicode marker — CSS handles styling
  color: string;        // CSS var name (e.g. 'signal', 'hazard')
}

const PING_TYPES: PingTypeDef[] = [
  { id: 'here',     label: 'ON ME',     icon: '◉', color: 'signal'  },
  { id: 'enemy',    label: 'ENEMY',     icon: '⚠', color: 'hazard'  },
  { id: 'defend',   label: 'DEFEND',    icon: '▣', color: 'cyan'    },
  { id: 'attack',   label: 'ATTACK',    icon: '▲', color: 'signal-hot' },
  { id: 'danger',   label: 'DANGER',    icon: '✕', color: 'hazard'  },
  { id: 'looking',  label: 'LOOKING',   icon: '?', color: 'bone-dim' },
];

interface ActivePing {
  worldPos: THREE.Vector3;
  type: PingType;
  spawnTime: number;
  el: HTMLDivElement;
  owner: 'self' | 'team';
}

const activePings: ActivePing[] = [];
const PING_LIFETIME = 6;            // seconds before auto-clear

// ── State ─────────────────────────────────────────────────────────────
let wheelEl: HTMLDivElement | null = null;
let pingContainer: HTMLDivElement | null = null;
let wheelOpen = false;
let hoveredType: PingType | null = null;
let wheelOpenTime = 0;

function isCommWheelInteractive(): boolean {
  return !gameState.roundOver && !gameState._introActive;
}

// ── DOM construction ──────────────────────────────────────────────────
// NOTE: No inline <style> block. All styling comes from index.css under
// the #pingWheel / .pw-* / .ping-* / .compass-ping-pip rules.

function ensureWheelContainer(): HTMLDivElement {
  if (wheelEl) return wheelEl;

  wheelEl = document.createElement('div');
  wheelEl.id = 'pingWheel';

  const wheelInner = document.createElement('div');
  wheelInner.className = 'pw-inner';

  // Build 6 radial slices
  const sliceCount = PING_TYPES.length;
  for (let i = 0; i < sliceCount; i++) {
    const def = PING_TYPES[i];
    const angle = (i / sliceCount) * Math.PI * 2 - Math.PI / 2;
    const r = 110;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;

    const slice = document.createElement('div');
    slice.className = 'pw-slice';
    slice.dataset.type = def.id;
    slice.style.transform = `translate(${x}px, ${y}px)`;
    slice.innerHTML = `
      <div class="pw-icon" data-color="${def.color}">${def.icon}</div>
      <div class="pw-label">${def.label}</div>
    `;
    wheelInner.appendChild(slice);
  }

  // Center hub
  const hub = document.createElement('div');
  hub.className = 'pw-hub';
  hub.innerHTML = `
    <div class="pw-hub-ring"></div>
    <div class="pw-hub-text">COMM</div>
  `;
  wheelInner.appendChild(hub);

  wheelEl.appendChild(wheelInner);
  document.body.appendChild(wheelEl);

  return wheelEl;
}

function ensurePingContainer(): HTMLDivElement {
  if (pingContainer) return pingContainer;
  pingContainer = document.createElement('div');
  pingContainer.id = 'pingContainer';
  document.body.appendChild(pingContainer);
  return pingContainer;
}

// ── Wheel open/close ──────────────────────────────────────────────────
function openWheel(): void {
  if (wheelOpen) return;
  wheelOpen = true;
  wheelOpenTime = performance.now() / 1000;
  const wheel = ensureWheelContainer();
  wheel.classList.add('on');
  hoveredType = null;
  updateSliceHighlight();

  // Slow time subtly via a body class — index.css can fade/darken the
  // scene. No inline filter manipulation here.
  document.body.classList.add('comm-wheel-open');

  // Unlock pointer for mouse-based slice selection
  document.exitPointerLock?.();
}

function closeWheel(commit: boolean): void {
  if (!wheelOpen) return;
  wheelOpen = false;
  const wheel = ensureWheelContainer();
  wheel.classList.remove('on');
  document.body.classList.remove('comm-wheel-open');

  if (commit && hoveredType) {
    // Issue the ping at the player's crosshair target position.
    const targetPos = raycastCrosshair();
    if (targetPos) placePing(targetPos, hoveredType, 'self');
  }

  hoveredType = null;

  // Re-lock pointer if we're still in a match
  if (isCommWheelInteractive()) {
    document.body.requestPointerLock?.();
  }
}

function updateSliceHighlight(): void {
  if (!wheelEl) return;
  wheelEl.querySelectorAll('.pw-slice').forEach(el => {
    const type = (el as HTMLElement).dataset.type;
    el.classList.toggle('hover', type === hoveredType);
  });
}

// ── Mouse tracking for wheel selection ────────────────────────────────
function onMouseMove(e: MouseEvent): void {
  if (!wheelOpen) return;

  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  const dist = Math.hypot(dx, dy);

  if (dist < 40) {
    hoveredType = null;
  } else {
    const angle = Math.atan2(dy, dx) + Math.PI / 2;
    const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
    const idx = Math.floor((normalized / (Math.PI * 2)) * PING_TYPES.length) % PING_TYPES.length;
    hoveredType = PING_TYPES[idx].id;
  }
  updateSliceHighlight();
}

// ── Raycast the crosshair to world to find ping target ────────────────
function raycastCrosshair(): THREE.Vector3 | null {
  const cam = gameState.camera;
  if (!cam) return null;

  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0), cam);

  // Intersect against loaded scene meshes
  const scene = gameState.scene;
  if (!scene) return null;
  const intersects = ray.intersectObjects(scene.children, true);

  for (const hit of intersects) {
    if (hit.distance > 0.5 && hit.distance < 150) {
      return hit.point.clone();
    }
  }

  // Fallback: project 30m forward along camera direction
  const fallback = new THREE.Vector3();
  cam.getWorldDirection(fallback);
  fallback.multiplyScalar(30).add(cam.position);
  return fallback;
}

// ── Public API ────────────────────────────────────────────────────────

export function placePing(worldPos: THREE.Vector3, type: PingType, owner: 'self' | 'team' = 'self'): void {
  const container = ensurePingContainer();
  const typeDef = PING_TYPES.find(t => t.id === type);
  if (!typeDef) return;

  const el = document.createElement('div');
  el.className = `ping-marker ping-${type} ping-${owner}`;
  el.innerHTML = `
    <div class="ping-dot" data-color="${typeDef.color}">${typeDef.icon}</div>
    <div class="ping-label">${typeDef.label}</div>
    <div class="ping-dist" data-dist="—">—</div>
  `;
  container.appendChild(el);

  activePings.push({
    worldPos: worldPos.clone(),
    type,
    spawnTime: gameState.worldElapsed,
    el,
    owner,
  });

  // Cap active pings at 8 — drop oldest
  while (activePings.length > 8) {
    const oldest = activePings.shift();
    if (oldest) oldest.el.remove();
  }

  playMedalSound('bronze');
}

export function updatePingSystem(_dt: number): void {
  if (activePings.length === 0) return;
  const cam = gameState.camera;
  if (!cam) return;

  const now = gameState.worldElapsed;
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;
  const tempVec = new THREE.Vector3();

  for (let i = activePings.length - 1; i >= 0; i--) {
    const ping = activePings[i];
    const age = now - ping.spawnTime;

    if (age >= PING_LIFETIME) {
      ping.el.remove();
      activePings.splice(i, 1);
      continue;
    }

    // Project to screen
    tempVec.copy(ping.worldPos).project(cam);
    const isBehind = tempVec.z > 1;

    // Edge clamp for behind-camera or offscreen — spec §5 item 10
    let screenX = (tempVec.x * 0.5 + 0.5) * screenW;
    let screenY = (-tempVec.y * 0.5 + 0.5) * screenH;
    let clamped = false;

    if (isBehind || screenX < 40 || screenX > screenW - 40
        || screenY < 40 || screenY > screenH - 40) {
      clamped = true;
      // If behind, flip to the opposite edge based on projected x sign.
      if (isBehind) {
        screenX = screenW - screenX;
        screenY = screenH - screenY;
      }
      // Clamp to a ring inside the viewport
      const margin = 80;
      screenX = Math.max(margin, Math.min(screenW - margin, screenX));
      screenY = Math.max(margin, Math.min(screenH - margin, screenY));
    }

    const dist = cam.position.distanceTo(ping.worldPos);

    // Fade last 20% of life
    const fadeStart = PILT() * 0.8;
    const alpha = age < fadeStart ? 1 : 1 - (age - fadeStart) / (PILT() * 0.2);

    ping.el.classList.toggle('clamped', clamped);
    ping.el.style.transform =
      `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0) translate(-50%, -50%)`;
    ping.el.style.opacity = alpha.toFixed(3);

    // Update distance readout
    const distEl = ping.el.querySelector('.ping-dist') as HTMLElement | null;
    if (distEl) {
      distEl.textContent = `${Math.round(dist)}M`;
      distEl.dataset.dist = String(Math.round(dist));
    }
  }
}

function PILT(): number { return PING_LIFETIME; }

export function getActivePings(): ReadonlyArray<{ worldPos: THREE.Vector3; type: PingType }> {
  return activePings.map(p => ({ worldPos: p.worldPos, type: p.type }));
}

export function clearAllPings(): void {
  for (const p of activePings) p.el.remove();
  activePings.length = 0;
}

export function initPingSystem(): void {
  ensureWheelContainer();
  ensurePingContainer();

  // Mouse tracking for slice hover (active only while wheel is open)
  document.addEventListener('mousemove', onMouseMove);

  // Q to open/hold comm wheel
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyQ' && !wheelOpen && isCommWheelInteractive()) {
      e.preventDefault();
      openWheel();
    }
    // Double-tap Q within 350ms = quick "ENEMY" ping at crosshair
    if (e.code === 'KeyQ' && !wheelOpen) {
      const now = performance.now() / 1000;
      if (now - wheelOpenTime > 0 && now - wheelOpenTime < 0.35) {
        const targetPos = raycastCrosshair();
        if (targetPos) placePing(targetPos, 'enemy', 'self');
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyQ' && wheelOpen) {
      e.preventDefault();
      closeWheel(true);
    }
    // ESC cancels without committing
    if (e.code === 'Escape' && wheelOpen) {
      closeWheel(false);
    }
  });

  // Click while wheel is open = commit
  document.addEventListener('mousedown', (e) => {
    if (wheelOpen) {
      e.preventDefault();
      closeWheel(true);
    }
  });
}
