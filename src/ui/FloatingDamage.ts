import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import type { TDMAgent } from '@/entities/TDMAgent';

/**
 * FloatingDamage — in-world damage numbers.
 *
 * APEX PROTOCOL spec §10 item 8:
 *   "When you hit the same target multiple times in <1s, numbers
 *    stack vertically on the target instead of scattering. More
 *    readable in combat."
 *
 * How it works:
 *   - Each spawned number records its target agent and spawn time.
 *   - When spawning a new number, we look for *active* numbers on the
 *     same target that are still fresh (spawned within 1.0s). If any
 *     exist, the new number anchors directly above the highest of
 *     them (rather than getting a random scatter offset).
 *   - During update, stacked siblings lerp toward their stack position
 *     so they visually form a neat vertical column instead of jitter.
 *
 * The pool is size-capped at 40 active numbers. Reuses DOM nodes.
 *
 * Public API preserved:
 *   initFloatingDamagePool()
 *   spawnDamageNumber(worldPos, amount, isHeadshot?, target?)
 *   updateFloatingDamage(dt)
 *   clearFloatingDamage()
 *   attachFloatingDamageWarmupProxy(), detachFloatingDamageWarmupProxy()
 */

const POOL_SIZE = 40;
const LIFETIME = 1.1;          // seconds
const RISE_SPEED = 0.9;        // world-units per second (upward float)
const STACK_GAP_PX = 24;       // vertical spacing between stacked numbers
const STACK_WINDOW = 1.0;      // seconds — "recent" threshold for stacking
const STACK_LERP_RATE = 18;    // how quickly a number slides into its stack slot

interface DamageNumber {
  el: HTMLDivElement;
  active: boolean;
  worldPos: THREE.Vector3;
  baseWorldPos: THREE.Vector3;
  target: TDMAgent | null;
  stackIndex: number;         // 0 = bottom of stack, 1+ stacked above
  spawnTime: number;
  amount: number;
  isHeadshot: boolean;
  // Screen-space offset animated toward stack position
  currentYOffsetPx: number;
  targetYOffsetPx: number;
}

const pool: DamageNumber[] = [];
let container: HTMLDivElement | null = null;

/**
 * Warm-up proxy: allows other systems (e.g. muzzle-flash pre-warm) to
 * call initFloatingDamagePool before the first shot.  Some legacy
 * callers use these symbols; keep them exported as no-op-safe.
 */
let warmupProxy: (() => void) | null = null;
export function attachFloatingDamageWarmupProxy(fn: () => void): void { warmupProxy = fn; }
export function detachFloatingDamageWarmupProxy(): void { warmupProxy = null; }

export function initFloatingDamagePool(): void {
  if (pool.length > 0) return;

  container = document.createElement('div');
  container.id = 'floatingDamageContainer';
  container.style.cssText = `
    position: fixed; inset: 0; pointer-events: none; z-index: 30;
    overflow: hidden;
  `;
  document.body.appendChild(container);

  for (let i = 0; i < POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'floating-damage';
    el.style.display = 'none';
    container.appendChild(el);

    pool.push({
      el,
      active: false,
      worldPos: new THREE.Vector3(),
      baseWorldPos: new THREE.Vector3(),
      target: null,
      stackIndex: 0,
      spawnTime: 0,
      amount: 0,
      isHeadshot: false,
      currentYOffsetPx: 0,
      targetYOffsetPx: 0,
    });
  }

  // Ping the warmup proxy if one was registered
  warmupProxy?.();
}

/**
 * Spawn a damage number at a world position.
 *
 * @param worldPos   where the hit landed (slightly above the target's chest)
 * @param amount     damage amount
 * @param isHeadshot whether it was a headshot (renders hazard-red, +weight)
 * @param target     the agent that took the hit — enables stacking
 */
export function spawnDamageNumber(
  worldPos: THREE.Vector3,
  amount: number,
  isHeadshot: boolean = false,
  target: TDMAgent | null = null,
): void {
  if (pool.length === 0) initFloatingDamagePool();

  // Find a free slot (prefer inactive; steal oldest active if full).
  let slot = pool.find(p => !p.active);
  if (!slot) {
    slot = pool.reduce((oldest, p) =>
      p.spawnTime < oldest.spawnTime ? p : oldest, pool[0]);
  }

  // ── STACKING (spec §10 item 8) ──
  // Count how many active numbers on this target are still "recent".
  const now = gameState.worldElapsed;
  let stackIndex = 0;
  if (target) {
    for (const p of pool) {
      if (p.active && p !== slot && p.target === target && now - p.spawnTime < STACK_WINDOW) {
        stackIndex++;
      }
    }
  }

  // Prime the slot
  slot.active = true;
  slot.worldPos.copy(worldPos);
  slot.baseWorldPos.copy(worldPos);
  slot.target = target;
  slot.stackIndex = stackIndex;
  slot.spawnTime = now;
  slot.amount = amount;
  slot.isHeadshot = isHeadshot;
  slot.currentYOffsetPx = stackIndex * STACK_GAP_PX;
  slot.targetYOffsetPx = stackIndex * STACK_GAP_PX;

  // Render the text + class state
  slot.el.textContent = isHeadshot ? `-${Math.round(amount)}` : String(Math.round(amount));
  slot.el.className = 'floating-damage' + (isHeadshot ? ' headshot' : '');
  if (stackIndex > 0) slot.el.classList.add('stacked');
  slot.el.style.display = 'block';
  slot.el.style.opacity = '1';
}

/**
 * Update every active floating damage number.
 * - Advances lifetime → fades out.
 * - Lifts in world space.
 * - Projects to screen, applies stack offset.
 */
export function updateFloatingDamage(dt: number): void {
  if (pool.length === 0) return;
  const camera = gameState.camera;
  if (!camera) return;

  const screenW = window.innerWidth;
  const screenH = window.innerHeight;
  const tempVec = new THREE.Vector3();
  const now = gameState.worldElapsed;

  for (const p of pool) {
    if (!p.active) continue;
    const age = now - p.spawnTime;

    if (age >= LIFETIME) {
      p.active = false;
      p.target = null;
      p.el.style.display = 'none';
      continue;
    }

    // World-space drift: upward only, no horizontal scatter (stacking
    // replaces that). Early-life numbers rise faster, settling near end.
    const riseEase = 1 - Math.pow(1 - age / LIFETIME, 2);
    p.worldPos.y = p.baseWorldPos.y + riseEase * RISE_SPEED;

    // Project to screen
    tempVec.copy(p.worldPos).project(camera);

    // If behind the camera, hide
    if (tempVec.z > 1) {
      p.el.style.display = 'none';
      continue;
    } else {
      p.el.style.display = 'block';
    }

    const screenX = (tempVec.x * 0.5 + 0.5) * screenW;
    const screenY = (-tempVec.y * 0.5 + 0.5) * screenH;

    // Lerp current screen-space Y-offset toward target so stacked
    // numbers slide into place over ~100ms instead of popping.
    const lerp = Math.min(1, dt * STACK_LERP_RATE);
    p.currentYOffsetPx += (p.targetYOffsetPx - p.currentYOffsetPx) * lerp;

    const finalX = screenX;
    const finalY = screenY - p.currentYOffsetPx;

    // Fade out in the last 30% of life
    const fadeStart = LIFETIME * 0.7;
    const alpha = age < fadeStart ? 1 : 1 - (age - fadeStart) / (LIFETIME - fadeStart);

    // Scale pop on spawn — larger for headshots
    const spawnScaleAge = Math.min(1, age / 0.12);
    const spawnScale = p.isHeadshot
      ? 0.6 + spawnScaleAge * 0.65
      : 0.7 + spawnScaleAge * 0.45;

    p.el.style.transform =
      `translate3d(${finalX.toFixed(1)}px, ${finalY.toFixed(1)}px, 0) ` +
      `translate(-50%, -50%) scale(${spawnScale.toFixed(3)})`;
    p.el.style.opacity = alpha.toFixed(3);
  }
}

export function clearFloatingDamage(): void {
  for (const p of pool) {
    p.active = false;
    p.target = null;
    p.el.style.display = 'none';
  }
}
