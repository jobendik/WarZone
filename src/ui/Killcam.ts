/**
 * Killcam + POTG (Play of the Game).
 *
 * Records a rolling 3.5s window of every agent's camera state. On death,
 * replays the killer's point of view for 3.2s. On match end, replays the
 * agent with the best short-window kill streak.
 *
 * EXTRA IDEA #3 — Chromatic aberration during killcam.
 * While the killcam is running we toggle `body.killcam-active`; the CSS
 * applies `filter: hue-rotate(8deg) saturate(1.4) contrast(1.15)` to the
 * scene canvas (#cw) for that "enemy vision" look.
 *
 * EXTRA IDEA #4 — POTG name-reveal slate.
 * The replay is overlaid with a full-width bottom slate:
 *   #potg > .potg-frame > .potg-label ("// PLAY OF THE GAME")
 *                       > .potg-name  (operator name, huge Archivo Black)
 *                       > .potg-meta  (stat strip with // separator)
 * The .potg-label types out via the CSS @keyframes potgType.
 * All visual styling is in index.css — this file only sets text content
 * and toggles classes.
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import type { TDMAgent } from '@/entities/TDMAgent';

interface CamSnapshot {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  time: number;
}

const HISTORY_DURATION = 3.5;
const snapshots = new Map<TDMAgent, CamSnapshot[]>();

// ─────────────────────────────────────────────────────────────────────
//  KILLCAM (on death)
// ─────────────────────────────────────────────────────────────────────

let active = false;
let killcamStart = 0;
const killcamDuration = 3.2;
let killcamTarget: TDMAgent | null = null;
let killcamEl: HTMLDivElement | null = null;

function ensureUI(): HTMLDivElement {
  if (killcamEl) return killcamEl;
  killcamEl = document.createElement('div');
  killcamEl.id = 'killcam';
  killcamEl.innerHTML = `
    <div class="kc-frame">
      <div class="kc-bar-top">
        <span class="kc-label">KILLCAM</span>
        <span class="kc-killer" id="kcKiller"></span>
      </div>
      <div class="kc-bar-bottom">
        <div class="kc-vignette"></div>
      </div>
    </div>
  `;
  document.body.appendChild(killcamEl);
  return killcamEl;
}

/**
 * Called every frame to record agent camera state.
 */
export function recordKillcamSnapshot(): void {
  const now = gameState.worldElapsed;
  for (const ag of gameState.agents) {
    if (ag === gameState.player || ag.isDead || !ag.active) continue;
    let arr = snapshots.get(ag);
    if (!arr) { arr = []; snapshots.set(ag, arr); }

    // Compute yaw from rotation quaternion's y/w components
    const qY = ag.rotation.y ?? 0;
    const qW = ag.rotation.w ?? 1;
    const yaw = 2 * Math.atan2(qY, qW);

    arr.push({
      pos:   new THREE.Vector3(ag.position.x, ag.position.y + 1.6, ag.position.z),
      yaw,
      pitch: 0,
      time:  now,
    });

    while (arr.length > 0 && now - arr[0].time > HISTORY_DURATION) arr.shift();
  }
}

export function startKillcam(killer: TDMAgent | null): void {
  if (!killer || killer.isDead) return;
  const arr = snapshots.get(killer);
  if (!arr || arr.length < 5) return;

  active = true;
  killcamTarget = killer;
  killcamStart = gameState.worldElapsed;

  const ui = ensureUI();
  ui.classList.add('on');
  const nameEl = document.getElementById('kcKiller');
  if (nameEl) nameEl.textContent = `KILLED BY ${killer.name.toUpperCase()}`;

  // EXTRA IDEA #3 — enemy-vision chromatic aberration on the scene.
  document.body.classList.add('killcam-active');
}

export function stopKillcam(): void {
  active = false;
  killcamTarget = null;
  if (killcamEl) killcamEl.classList.remove('on');
  document.body.classList.remove('killcam-active');
}

export function isKillcamActive(): boolean { return active; }

/**
 * Update killcam camera position — call from game loop while active.
 * Returns true while the killcam is driving the camera.
 */
export function updateKillcam(_dt: number): boolean {
  if (!active || !killcamTarget) return false;

  const elapsed = gameState.worldElapsed - killcamStart;
  if (elapsed >= killcamDuration) {
    stopKillcam();
    return false;
  }

  const arr = snapshots.get(killcamTarget);
  if (!arr || arr.length === 0) { stopKillcam(); return false; }

  // Map elapsed (0..duration) onto the snapshot history window.
  const t = elapsed / killcamDuration;
  const targetTime = arr[arr.length - 1].time - HISTORY_DURATION + t * HISTORY_DURATION;

  let prev = arr[0];
  let next = arr[arr.length - 1];
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i].time <= targetTime && arr[i + 1].time >= targetTime) {
      prev = arr[i]; next = arr[i + 1]; break;
    }
  }
  const segT = (targetTime - prev.time) / Math.max(0.001, next.time - prev.time);
  const pos = new THREE.Vector3().lerpVectors(prev.pos, next.pos, Math.max(0, Math.min(1, segT)));
  const yaw = THREE.MathUtils.lerp(prev.yaw, next.yaw, segT);

  // Position camera behind the killer's shoulder.
  const offsetX = -Math.sin(yaw) * 1.2;
  const offsetZ = -Math.cos(yaw) * 1.2;
  gameState.camera.position.set(pos.x + offsetX, pos.y + 0.5, pos.z + offsetZ);

  const lookTarget = new THREE.Vector3(
    pos.x + Math.sin(yaw) * 5,
    pos.y - 0.2,
    pos.z + Math.cos(yaw) * 5,
  );
  gameState.camera.lookAt(lookTarget);

  return true;
}

export function clearKillcamSnapshots(): void {
  snapshots.clear();
  active = false;
  killcamTarget = null;
  document.body.classList.remove('killcam-active');
}

// ─────────────────────────────────────────────────────────────────────
//  POTG — Play of the Game (EXTRA IDEA #4)
// ─────────────────────────────────────────────────────────────────────

let potgActive = false;
let potgStart = 0;
const POTG_DURATION = 5;
let potgTarget: TDMAgent | null = null;
let potgEl: HTMLDivElement | null = null;

/**
 * Builds the POTG overlay DOM. ALL visual styling is in index.css
 * (#potg, .potg-frame, .potg-label, .potg-name, .potg-meta) — no inline
 * styles here.  .potg-label animates via @keyframes potgType.
 */
function ensurePotgUI(): HTMLDivElement {
  if (potgEl) return potgEl;
  potgEl = document.createElement('div');
  potgEl.id = 'potg';
  potgEl.innerHTML = `
    <div class="potg-frame">
      <div class="potg-label">// PLAY OF THE GAME</div>
      <div class="potg-name" id="potgName">—</div>
      <div class="potg-meta" id="potgMeta"></div>
    </div>
  `;
  document.body.appendChild(potgEl);
  return potgEl;
}

/**
 * Start the POTG replay for a given agent. Call before showing round
 * summary when a POTG-eligible agent exists.
 */
export function startPotgReplay(agent: TDMAgent): void {
  const arr = snapshots.get(agent);
  if (!arr || arr.length < 5) return;

  potgActive = true;
  potgStart  = gameState.worldElapsed;
  potgTarget = agent;

  const ui = ensurePotgUI();
  ui.classList.add('on');

  // Name — "YOU" for the player, OPERATOR name for bots.
  const nameEl = document.getElementById('potgName');
  if (nameEl) {
    nameEl.textContent = agent === gameState.player ? 'YOU' : agent.name.toUpperCase();
  }

  // Meta — stats strip. Uses <b> for the amber accent (see .potg-meta b).
  const metaEl = document.getElementById('potgMeta');
  if (metaEl) {
    const kills = agent === gameState.player ? gameState.pKills : agent.kills;
    const streak = gameState.potgBestScore ?? 0;
    const weapon = (agent as any).lastWeaponName ?? 'UNKNOWN';
    metaEl.innerHTML = `
      <span>KILLS <b>${kills}</b></span>
      <span>STREAK <b>${streak}</b></span>
      <span>WEAPON <b>${String(weapon).toUpperCase()}</b></span>
    `;
  }
}

export function isPotgActive(): boolean { return potgActive; }

export function updatePotgReplay(_dt: number): boolean {
  if (!potgActive || !potgTarget) return false;

  const elapsed = gameState.worldElapsed - potgStart;
  if (elapsed >= POTG_DURATION) {
    potgActive = false;
    potgTarget = null;
    if (potgEl) potgEl.classList.remove('on');
    return false;
  }

  const arr = snapshots.get(potgTarget);
  if (!arr || arr.length === 0) {
    potgActive = false;
    if (potgEl) potgEl.classList.remove('on');
    return false;
  }

  const t = elapsed / POTG_DURATION;
  const targetTime = arr[arr.length - 1].time - HISTORY_DURATION + t * HISTORY_DURATION;

  let prev = arr[0];
  let next = arr[arr.length - 1];
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i].time <= targetTime && arr[i + 1].time >= targetTime) {
      prev = arr[i]; next = arr[i + 1]; break;
    }
  }
  const segT = (targetTime - prev.time) / Math.max(0.001, next.time - prev.time);
  const pos = new THREE.Vector3().lerpVectors(prev.pos, next.pos, Math.max(0, Math.min(1, segT)));
  const yaw = THREE.MathUtils.lerp(prev.yaw, next.yaw, segT);

  const offsetX = -Math.sin(yaw) * 1.5;
  const offsetZ = -Math.cos(yaw) * 1.5;
  gameState.camera.position.set(pos.x + offsetX, pos.y + 0.6, pos.z + offsetZ);

  const lookTarget = new THREE.Vector3(
    pos.x + Math.sin(yaw) * 5,
    pos.y - 0.1,
    pos.z + Math.cos(yaw) * 5,
  );
  gameState.camera.lookAt(lookTarget);

  return true;
}

export function stopPotgReplay(): void {
  potgActive = false;
  potgTarget = null;
  if (potgEl) potgEl.classList.remove('on');
}
