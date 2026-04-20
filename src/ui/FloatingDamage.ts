import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import type { TDMAgent } from '@/entities/TDMAgent';

/**
 * FloatingDamage — in-world damage numbers.
 *
 * Supports both call styles:
 *   spawnDamageNumber(worldPos, amount, isHeadshot?, target?)
 *   spawnDamageNumber(worldPos, { amount, isHeadshot?, isFalloff?, isKill?, target? })
 */

const POOL_SIZE = 40;
const LIFETIME = 1.1;          // seconds
const RISE_SPEED = 0.9;        // world-units per second (upward float)
const STACK_GAP_PX = 24;       // vertical spacing between stacked numbers
const STACK_WINDOW = 1.0;      // seconds — "recent" threshold for stacking
const STACK_LERP_RATE = 18;    // how quickly a number slides into its stack slot

export interface SpawnDamageNumberOptions {
  amount: number;
  isHeadshot?: boolean;
  isFalloff?: boolean;
  isKill?: boolean;
  target?: TDMAgent | null;
}

interface DamageNumber {
  el: HTMLDivElement;
  active: boolean;
  worldPos: THREE.Vector3;
  baseWorldPos: THREE.Vector3;
  target: TDMAgent | null;
  stackIndex: number;
  spawnTime: number;
  amount: number;
  isHeadshot: boolean;
  isFalloff: boolean;
  isKill: boolean;
  currentYOffsetPx: number;
  targetYOffsetPx: number;
}

const pool: DamageNumber[] = [];
let container: HTMLDivElement | null = null;

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
      isFalloff: false,
      isKill: false,
      currentYOffsetPx: 0,
      targetYOffsetPx: 0,
    });
  }

  warmupProxy?.();
}

export function spawnDamageNumber(
  worldPos: THREE.Vector3,
  amount: number,
  isHeadshot?: boolean,
  target?: TDMAgent | null,
): void;
export function spawnDamageNumber(
  worldPos: THREE.Vector3,
  options: SpawnDamageNumberOptions,
): void;
export function spawnDamageNumber(
  worldPos: THREE.Vector3,
  amountOrOptions: number | SpawnDamageNumberOptions,
  isHeadshot = false,
  target: TDMAgent | null = null,
): void {
  if (pool.length === 0) initFloatingDamagePool();

  let amount: number;
  let isFalloff = false;
  let isKill = false;

  if (typeof amountOrOptions === 'number') {
    amount = amountOrOptions;
  } else {
    amount = amountOrOptions.amount;
    isHeadshot = Boolean(amountOrOptions.isHeadshot);
    isFalloff = Boolean(amountOrOptions.isFalloff);
    isKill = Boolean(amountOrOptions.isKill);
    target = amountOrOptions.target ?? null;
  }

  let slot = pool.find(p => !p.active);
  if (!slot) {
    slot = pool.reduce((oldest, p) =>
      p.spawnTime < oldest.spawnTime ? p : oldest, pool[0]);
  }

  const now = gameState.worldElapsed;
  let stackIndex = 0;
  if (target) {
    for (const p of pool) {
      if (p.active && p !== slot && p.target === target && now - p.spawnTime < STACK_WINDOW) {
        stackIndex++;
      }
    }
  }

  slot.active = true;
  slot.worldPos.copy(worldPos);
  slot.baseWorldPos.copy(worldPos);
  slot.target = target;
  slot.stackIndex = stackIndex;
  slot.spawnTime = now;
  slot.amount = amount;
  slot.isHeadshot = isHeadshot;
  slot.isFalloff = isFalloff;
  slot.isKill = isKill;
  slot.currentYOffsetPx = stackIndex * STACK_GAP_PX;
  slot.targetYOffsetPx = stackIndex * STACK_GAP_PX;

  slot.el.textContent = isKill
    ? 'KILL'
    : (isHeadshot ? `-${Math.round(amount)}` : String(Math.round(amount)));

  slot.el.className = 'floating-damage';
  if (isHeadshot) slot.el.classList.add('headshot');
  if (isFalloff) slot.el.classList.add('falloff');
  if (isKill) slot.el.classList.add('kill');
  if (stackIndex > 0) slot.el.classList.add('stacked');
  slot.el.style.display = 'block';
  slot.el.style.opacity = '1';
}

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

    const riseEase = 1 - Math.pow(1 - age / LIFETIME, 2);
    p.worldPos.y = p.baseWorldPos.y + riseEase * RISE_SPEED;

    tempVec.copy(p.worldPos).project(camera);

    if (tempVec.z > 1) {
      p.el.style.display = 'none';
      continue;
    } else {
      p.el.style.display = 'block';
    }

    const screenX = (tempVec.x * 0.5 + 0.5) * screenW;
    const screenY = (-tempVec.y * 0.5 + 0.5) * screenH;

    const lerp = Math.min(1, dt * STACK_LERP_RATE);
    p.currentYOffsetPx += (p.targetYOffsetPx - p.currentYOffsetPx) * lerp;

    const finalX = screenX;
    const finalY = screenY - p.currentYOffsetPx;

    const fadeStart = LIFETIME * 0.7;
    const alpha = age < fadeStart ? 1 : 1 - (age - fadeStart) / (LIFETIME - fadeStart);

    const spawnScaleAge = Math.min(1, age / 0.12);
    const spawnScale = p.isKill
      ? 0.9 + spawnScaleAge * 0.55
      : p.isHeadshot
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
