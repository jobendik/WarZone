import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import type { TDMAgent } from '@/entities/TDMAgent';

/** Adaptive difficulty: returns a multiplier for bot aim spread based on player K/D */
function getAdaptiveDifficulty(): number {
  const k = gameState.pKills;
  const d = gameState.pDeaths;
  if (k + d < 3) return 1;
  const kd = k / Math.max(1, d);
  if (kd > 2.5) return 0.85;
  if (kd > 1.5) return 0.95;
  if (kd < 0.4) return 1.3;
  if (kd < 0.7) return 1.15;
  return 1;
}

/**
 * Per-agent simulated crosshair state.
 * Stored as a world-space direction pair (yaw/pitch) that moves toward
 * the desired target direction via spring dynamics — flick, settle, track, flinch.
 *
 * Critically: this only affects the FIRING direction, not the agent's body
 * rotation. YUKA continues to control body orientation through steering.
 */
export interface AimState {
  yaw: number;
  pitch: number;
  velYaw: number;
  velPitch: number;
  flinchYaw: number;
  flinchPitch: number;
  overshootPhase: number;
  onTargetTime: number;
  lastTargetPos: YUKA.Vector3;
  driftPhaseYaw: number;
  driftPhasePitch: number;
  /** Whether aim has been initialized — first frame snaps instantly to target. */
  initialized: boolean;
}

export function createAimState(): AimState {
  return {
    yaw: 0,
    pitch: 0,
    velYaw: 0,
    velPitch: 0,
    flinchYaw: 0,
    flinchPitch: 0,
    overshootPhase: 0,
    onTargetTime: 0,
    lastTargetPos: new YUKA.Vector3(),
    driftPhaseYaw: Math.random() * Math.PI * 2,
    driftPhasePitch: Math.random() * Math.PI * 2,
    initialized: false,
  };
}

// Cached temporaries
const _targetPos = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _vel = new THREE.Vector3();

// Scratch output vectors for getAimDirection() — returned by reference.
// Callers MUST NOT retain the returned refs across frames (they are
// overwritten by the next call). The AI shot path reads them
// synchronously before the next bot's aim is evaluated.
const _aimOutDir = new THREE.Vector3();
const _aimOutOrigin = new THREE.Vector3();

function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function getLeadTime(ag: TDMAgent, dist: number): number {
  if (ag.weaponId === 'rocket_launcher') return Math.min(0.9, dist / 25);
  return Math.min(0.12, dist * 0.004);
}

/**
 * Compute the current yaw the agent's body is facing (for bots with no target
 * we fall back to this so the crosshair points forward).
 */
function getAgentHeadingYaw(ag: TDMAgent): number {
  // YUKA encodes rotation as a quaternion; extract Y yaw.
  const qY = ag.rotation.y ?? 0;
  const qW = ag.rotation.w ?? 1;
  return 2 * Math.atan2(qY, qW);
}

/**
 * Update the bot's simulated crosshair each frame.
 */
export function updateAim(ag: TDMAgent, dt: number): void {
  if (!ag.aim) return;
  const aim = ag.aim;
  const p = ag.personality;
  if (!p) return;

  // ── Determine desired target direction ──
  const tgtAgent = ag.currentTarget;
  _origin.set(ag.position.x, 0.95, ag.position.z);

  let desiredYaw: number;
  let desiredPitch: number;

  if (tgtAgent && !tgtAgent.isDead) {
    const dist = ag.position.distanceTo(tgtAgent.position);
    const leadTime = getLeadTime(ag, dist);

    _vel.set(tgtAgent.velocity.x, 0, tgtAgent.velocity.z);
    const biasedLead = leadTime * (1 + p.leadErrorBias * 0.3);
    _targetPos.set(
      tgtAgent.position.x + _vel.x * biasedLead,
      1.0,
      tgtAgent.position.z + _vel.z * biasedLead,
    );
    const aimHigh = p.skill * 0.35;
    _targetPos.y = 1.0 + aimHigh * (Math.random() * 0.4);

    aim.lastTargetPos.copy(tgtAgent.position);
    aim.onTargetTime += dt;
  } else if (ag.hasLastKnown) {
    _targetPos.set(ag.lastKnownPos.x, 1.1, ag.lastKnownPos.z);
    aim.onTargetTime = 0;
  } else if (ag.preAimPos) {
    // Pre-aim: point crosshair at predicted engagement position
    _targetPos.set(ag.preAimPos.x, 1.0, ag.preAimPos.z);
    aim.onTargetTime = 0;
  } else {
    // Default: aim forward along body heading
    const bodyYaw = getAgentHeadingYaw(ag);
    _targetPos.set(
      ag.position.x - Math.sin(bodyYaw) * 10,
      1.1,
      ag.position.z - Math.cos(bodyYaw) * 10,
    );
    aim.onTargetTime = 0;
  }

  _toTarget.subVectors(_targetPos, _origin);
  desiredYaw = Math.atan2(-_toTarget.x, -_toTarget.z);
  const horizDist = Math.sqrt(_toTarget.x * _toTarget.x + _toTarget.z * _toTarget.z);
  desiredPitch = Math.atan2(_toTarget.y, Math.max(0.01, horizDist));

  // First frame — snap so we don't start from yaw=0
  if (!aim.initialized) {
    aim.yaw = desiredYaw;
    aim.pitch = desiredPitch;
    aim.velYaw = 0;
    aim.velPitch = 0;
    aim.initialized = true;
    return;
  }

  // ── Spring dynamics ──
  const deltaYaw = normAngle(desiredYaw - aim.yaw);
  const deltaPitch = desiredPitch - aim.pitch;

  const flickSize = Math.sqrt(deltaYaw * deltaYaw + deltaPitch * deltaPitch);
  if (flickSize > 0.6 && aim.overshootPhase <= 0) {
    aim.overshootPhase = 0.25 * (1 + p.overshootTendency);
    const overshoot = p.overshootTendency * 1.2;
    aim.velYaw += deltaYaw * overshoot * 0.4;
    aim.velPitch += deltaPitch * overshoot * 0.4;
  }
  if (aim.overshootPhase > 0) aim.overshootPhase = Math.max(0, aim.overshootPhase - dt);

  const stiffness = 18 + p.trackingResponsiveness * 30;
  const damping = 6 + p.settleSpeed * 10;

  aim.velYaw += deltaYaw * stiffness * dt;
  aim.velPitch += deltaPitch * stiffness * dt;
  aim.velYaw *= Math.max(0, 1 - damping * dt);
  aim.velPitch *= Math.max(0, 1 - damping * dt);

  aim.yaw += aim.velYaw * dt;
  aim.pitch += aim.velPitch * dt;
  aim.yaw = normAngle(aim.yaw);

  // Micro-jitter
  const recentDmg = Math.max(0, 1 - (gameState.worldElapsed - ag.lastDamageTime) * 2);
  const jitterScale = p.microJitter * (1 + ag.pressureLevel * 1.5 + recentDmg * 2);
  aim.yaw += (Math.random() - 0.5) * jitterScale;
  aim.pitch += (Math.random() - 0.5) * jitterScale * 0.6;

  // Slow drift
  aim.driftPhaseYaw += dt * 0.7;
  aim.driftPhasePitch += dt * 0.55;
  const driftAmp = 0.004 * (1.4 - p.skill);
  aim.yaw += Math.sin(aim.driftPhaseYaw) * driftAmp * dt;
  aim.pitch += Math.cos(aim.driftPhasePitch) * driftAmp * 0.6 * dt;

  // Flinch decay
  const flinchDecay = Math.max(0, 1 - dt * 6);
  aim.flinchYaw *= flinchDecay;
  aim.flinchPitch *= flinchDecay;
  aim.yaw += aim.flinchYaw * dt;
  aim.pitch += aim.flinchPitch * dt;

  aim.pitch = Math.max(-0.9, Math.min(0.9, aim.pitch));

  // NOTE: We DO NOT override ag.rotation here.
  // YUKA's steering manager is in control of the body rotation.
  // The aim state is only consulted when the agent fires (getAimDirection).
}

/**
 * Apply a flinch impulse — called when the bot takes damage.
 */
export function applyAimFlinch(ag: TDMAgent, damageFraction: number): void {
  if (!ag.aim || !ag.personality) return;
  const strength = ag.personality.flinchFactor * damageFraction * 0.35;
  ag.aim.flinchYaw += (Math.random() - 0.5) * strength * 12;
  ag.aim.flinchPitch += (Math.random() - 0.2) * strength * 6;
}

/**
 * Returns the actual firing direction based on current simulated crosshair.
 * Panic spread scales with pressure + personality.
 *
 * `settled` = crosshair not in overshoot and angular velocity is below threshold.
 * This is informational only; callers may choose to ignore it.
 */
export function getAimDirection(ag: TDMAgent): {
  dir: THREE.Vector3;
  origin: THREE.Vector3;
  settled: boolean;
} {
  const aim = ag.aim;
  const p = ag.personality;

  // PERF: return shared scratch vectors instead of allocating fresh
  // Vector3s per call. Bots fire at 10Hz and this runs every shot.
  _aimOutOrigin.set(ag.position.x, 0.95, ag.position.z);

  // Fallback: no aim state yet — fire toward the current target directly
  if (!aim || !p) {
    if (ag.currentTarget) {
      _aimOutDir.set(
        ag.currentTarget.position.x - ag.position.x,
        0.1,
        ag.currentTarget.position.z - ag.position.z,
      ).normalize();
      return { dir: _aimOutDir, origin: _aimOutOrigin, settled: true };
    }
    _aimOutDir.set(0, 0, -1);
    return { dir: _aimOutDir, origin: _aimOutOrigin, settled: true };
  }

  const panicSpread = p.panicSprayFactor * ag.pressureLevel * 0.09;
  // Adaptive difficulty: widen/tighten spread based on player performance
  const adaptiveMul = getAdaptiveDifficulty();
  const yaw = aim.yaw + (Math.random() - 0.5) * panicSpread * adaptiveMul;
  const pitch = aim.pitch + (Math.random() - 0.5) * panicSpread * 0.5 * adaptiveMul;

  _aimOutDir.set(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ).normalize();

  const angularSpeed = Math.abs(aim.velYaw) + Math.abs(aim.velPitch);
  const settleThreshold = 0.5 + (1 - p.triggerDiscipline) * 2.0;
  const settled = aim.overshootPhase <= 0 && angularSpeed < settleThreshold;

  return { dir: _aimOutDir, origin: _aimOutOrigin, settled };
}

/**
 * Check if the simulated crosshair is close enough to the target to shoot.
 * Used as a soft gate (callers may ignore).
 */
function isAimOnTarget(ag: TDMAgent, target: TDMAgent, tolerance = 0.3): boolean {
  if (!ag.aim || !ag.aim.initialized) return true; // don't block on uninit

  const aim = ag.aim;
  const tx = target.position.x - ag.position.x;
  const tz = target.position.z - ag.position.z;
  const desiredYaw = Math.atan2(-tx, -tz);
  const delta = Math.abs(normAngle(desiredYaw - aim.yaw));

  const dist = Math.sqrt(tx * tx + tz * tz);
  const distAdjust = Math.max(0, (dist - 10) / 30) * 0.15;
  return delta < (tolerance + distAdjust);
}
