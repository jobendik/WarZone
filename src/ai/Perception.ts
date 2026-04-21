import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import type { TDMAgent, EnemyMemoryEntry } from '@/entities/TDMAgent';
import { isEnemy, isFreeForAll } from '@/core/GameModes';
import { getContextualVisionMod, applySuppression, getHearingAttenuation } from './ContextualPerception';

const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _toTarget = new YUKA.Vector3();
const _heading = new YUKA.Vector3();

// Dedicated raycaster for LOS — keeps three-mesh-bvh's `firstHitOnly` flag
// from leaking into other systems (Hitscan needs the *nearest* hit, not any).
const _losRaycaster = new THREE.Raycaster();
(_losRaycaster as any).firstHitOnly = true;

const PERCEPTION_STAGGER = 3;

// ── LOS cache ───────────────────────────────────────────────────────────────
// CoverSystem and Perception query isOccluded() many times per frame. With
// many agents engaging at once this becomes the dominant cost. Quantizing
// from/to to a 0.5m grid and caching results inside a single frame gives a
// large speedup with no perceivable accuracy loss (walls don't move and
// agents barely move within one frame).
const _losCache = new Map<string, boolean>();
let _losCacheFrame = -1;
const _LOS_GRID = 0.5; // meters per cell — tighter = more accurate, less reuse

function _losKey(fx: number, fz: number, tx: number, tz: number): string {
  const a = (fx / _LOS_GRID) | 0;
  const b = (fz / _LOS_GRID) | 0;
  const c = (tx / _LOS_GRID) | 0;
  const d = (tz / _LOS_GRID) | 0;
  return `${a},${b},${c},${d}`;
}

export function isOccluded(from: YUKA.Vector3, to: YUKA.Vector3): boolean {
  // Drop the cache when the frame changes.
  const frame = gameState.perceptionFrame;
  if (frame !== _losCacheFrame) {
    _losCache.clear();
    _losCacheFrame = frame;
  }

  const key = _losKey(from.x, from.z, to.x, to.z);
  const cached = _losCache.get(key);
  if (cached !== undefined) return cached;

  _origin.set(from.x, 0.9, from.z);
  _target.set(to.x, 1.0, to.z);
  _dir.subVectors(_target, _origin);
  const dist = _dir.length();
  if (dist < 0.01) {
    _losCache.set(key, false);
    return false;
  }
  _dir.normalize();
  _losRaycaster.set(_origin, _dir);
  _losRaycaster.far = dist;
  const hits = _losRaycaster.intersectObjects(gameState.wallMeshes, false);
  const result = hits.length > 0 && hits[0].distance < dist;
  _losCache.set(key, result);
  return result;
}

export function canSee(ag: TDMAgent, target: TDMAgent): boolean {
if (ag.isDead || target.isDead) return false;
if (!isEnemy(ag, target)) return false;
// Contextual modifiers: reload, tunnel vision, pressure, alert, tilt
const ctx = getContextualVisionMod(ag);
// BR: bots see much farther. TDM values (28-55m) are useless on a 320m map.
const rangeMul = (gameState.mode === 'br' ? 3.2 : 1.0) * ctx.rangeMul;
const fovMul   = (gameState.mode === 'br' ? 1.15 : 1.0) * ctx.fovMul;
const dist = ag.position.distanceTo(target.position);
if (dist > ag.visionRange * rangeMul) return false;
_toTarget.subVectors(target.position, ag.position).normalize();
_heading.set(0, 0, 1).applyRotation(ag.rotation);
const dot = _heading.dot(_toTarget);
const tunnelPenalty = ag.personality ? ag.personality.tunnelVision * 0.15 : 0;
const effectiveFOV = Math.min(Math.PI, ag.visionFOV * (1 - tunnelPenalty) * fovMul);
if (dot < Math.cos(effectiveFOV * 0.5)) return false;
// Miss chance: probabilistic failure to register a sighting
if (ctx.missChance > 0 && Math.random() < ctx.missChance) return false;
return !isOccluded(ag.position, target.position);
}

export function shouldRunPerception(ag: TDMAgent): boolean {
  return (gameState.perceptionFrame + ag.perceptionSlot) % PERCEPTION_STAGGER === 0;
}

export function updateEnemyMemory(ag: TDMAgent, enemy: TDMAgent, source: 'visual' | 'audio' | 'callout' | 'damage'): void {
  const existing = ag.enemyMemory.get(enemy.name);
  const now = gameState.worldElapsed;

  if (existing) {
    existing.lastSeenPos.copy(enemy.position);
    existing.lastSeenTime = now;
    existing.source = source;
    existing.confidence = source === 'visual' ? 1.0 : source === 'damage' ? 0.9 : source === 'callout' ? 0.6 : 0.4;
    existing.wasMoving = enemy.velocity.length() > 0.5;
    existing.lastVelocity.copy(enemy.velocity);
    const dist = ag.position.distanceTo(enemy.position);
    existing.threat = Math.max(0, 100 - dist * 1.5 - (enemy.hp / enemy.maxHP) * 20);
  } else {
    const entry: EnemyMemoryEntry = {
      lastSeenPos: new YUKA.Vector3().copy(enemy.position),
      lastSeenTime: now,
      source,
      confidence: source === 'visual' ? 1.0 : 0.5,
      threat: 50,
      wasMoving: enemy.velocity.length() > 0.5,
      lastVelocity: new YUKA.Vector3().copy(enemy.velocity),
    };
    ag.enemyMemory.set(enemy.name, entry);
  }
}

export function decayEnemyMemory(ag: TDMAgent, dt: number): void {
  const now = gameState.worldElapsed;
  const toDelete: string[] = [];

  // Personality: high attention-span bots remember longer
  const attentionMul = ag.personality ? (1.3 - ag.personality.attentionSpan * 0.5) : 1;

  for (const [name, entry] of ag.enemyMemory) {
    const age = now - entry.lastSeenTime;
    const baseDecay = entry.source === 'visual' ? 0.15 : 0.3;
    entry.confidence = Math.max(0, entry.confidence - dt * baseDecay * attentionMul);

    if (age > 2 && entry.wasMoving && entry.confidence > 0.1) {
      entry.lastSeenPos.x += entry.lastVelocity.x * dt * 0.3;
      entry.lastSeenPos.z += entry.lastVelocity.z * dt * 0.3;
    }

    if (entry.confidence <= 0 || age > 20) toDelete.push(name);
  }

  for (const name of toDelete) ag.enemyMemory.delete(name);
}

/**
 * Legacy broadcast — kept as a fallback but AIController now uses queueCallout
 * from TeamIntel.ts. This function still exists for any code that imports it.
 */
function broadcastEnemyPosition(spotter: TDMAgent, enemy: TDMAgent): void {
  // Delegation preserved for compatibility but AIController queues via TeamIntel directly.
  // We still update spotter's own memory from visual source.
  updateEnemyMemory(spotter, enemy, 'visual');
}

export function checkAudioAwareness(ag: TDMAgent): void {
  if (ag.isDead) return;

  const timeSinceDmg = gameState.worldElapsed - ag.lastDamageTime;
  if (timeSinceDmg < 0.5 && ag.lastAttacker && !ag.lastAttacker.isDead) {
    ag.alertLevel = Math.min(100, ag.alertLevel + 40);
    updateEnemyMemory(ag, ag.lastAttacker, 'damage');
    if (!ag.hasTarget) {
      // Damage-based LKP gets noise — you don't know exactly where they shot from
      const noise = 3 + (ag.personality ? (1 - ag.personality.skill) * 5 : 3);
      ag.lastKnownPos.set(
        ag.lastAttacker.position.x + (Math.random() - 0.5) * noise,
        0,
        ag.lastAttacker.position.z + (Math.random() - 0.5) * noise,
      );
      ag.hasLastKnown = true;
    }
    return;
  }

  // Hear nearby enemy footsteps (sprinting/running)
  const footstepRange = ag.personality ? 15 + ag.personality.skill * 10 : 18;
  const footstepRangeSq = footstepRange * footstepRange;
  for (const other of gameState.agents) {
    if (other === ag || other.isDead || other.team === ag.team) continue;
    const dx = ag.position.x - other.position.x;
    const dz = ag.position.z - other.position.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > footstepRangeSq) continue;
    // Wall occlusion attenuates hearing
    const att = getHearingAttenuation(ag.position, other.position);
    if (att < 0.15) continue;
    // Only hear enemies who are moving fast (sprinting/running)
    const speed = other.velocity.length();
    if (speed < 3) continue;
    // Crouching enemies are silent
    if (other.isBotCrouching) continue;
    const hearChance = speed > 6 ? 0.06 : 0.02;
    if (Math.random() > hearChance) continue;
    ag.alertLevel = Math.min(100, ag.alertLevel + 12);
    updateEnemyMemory(ag, other, 'audio');
    if (!ag.hasTarget && !ag.hasLastKnown) {
      const noise = 5 + (ag.personality ? (1 - ag.personality.skill) * 4 : 3);
      ag.lastKnownPos.set(
        other.position.x + (Math.random() - 0.5) * noise,
        0,
        other.position.z + (Math.random() - 0.5) * noise,
      );
      ag.hasLastKnown = true;
    }
    break;
  }

  // Hear nearby enemy reloading
  const reloadHearRange = 10;
  const reloadHearRangeSq = reloadHearRange * reloadHearRange;
  for (const other of gameState.agents) {
    if (other === ag || other.isDead || other.team === ag.team) continue;
    if (!other.isReloading) continue;
    const dx = ag.position.x - other.position.x;
    const dz = ag.position.z - other.position.z;
    if (dx * dx + dz * dz < reloadHearRangeSq) {
      ag.alertLevel = Math.min(100, ag.alertLevel + 20);
      updateEnemyMemory(ag, other, 'audio');
      if (!ag.hasTarget) {
        const noise = 2;
        ag.lastKnownPos.set(
          other.position.x + (Math.random() - 0.5) * noise,
          0,
          other.position.z + (Math.random() - 0.5) * noise,
        );
        ag.hasLastKnown = true;
      }
      break;
    }
  }

  const hearRange = 25;
  const hearRangeSq = hearRange * hearRange;
  const suppressRange = 3; // near-miss suppression radius
  const suppressRangeSq = suppressRange * suppressRange;
  const checkCount = Math.min(gameState.bullets.length, 5);
  for (let j = 0; j < checkCount; j++) {
    const bullet = gameState.bullets[j];
    if (bullet.ownerTeam === ag.team) continue;
    const dx = ag.position.x - bullet.mesh.position.x;
    const dz = ag.position.z - bullet.mesh.position.z;
    const distSq = dx * dx + dz * dz;

    // Near-miss suppression — flinch and delay shooting
    if (distSq < suppressRangeSq) {
      applySuppression(ag, Math.sqrt(distSq));
      ag.shootTimer = Math.max(ag.shootTimer, 0.3 + Math.random() * 0.2);
      if (!ag.hasTarget && !ag.hasLastKnown) {
        const noise = 4;
        ag.lastKnownPos.set(
          bullet.mesh.position.x + (Math.random() - 0.5) * noise,
          0,
          bullet.mesh.position.z + (Math.random() - 0.5) * noise,
        );
        ag.hasLastKnown = true;
      }
      break;
    }

    if (distSq < hearRangeSq) {
      ag.alertLevel = Math.min(100, ag.alertLevel + 8);
      if (!ag.hasTarget && !ag.hasLastKnown) {
        const noise = 4;
        ag.lastKnownPos.set(
          bullet.mesh.position.x + (Math.random() - 0.5) * noise,
          0,
          bullet.mesh.position.z + (Math.random() - 0.5) * noise,
        );
        ag.hasLastKnown = true;
      }
      break;
    }
  }
}

function scoreTarget(ag: TDMAgent, target: TDMAgent, dist: number): number {
  let score = 0;

  const rangeDiff = Math.abs(dist - ag.preferredRange);
  score -= rangeDiff * 0.5;

  const hpRatio = target.hp / target.maxHP;
  if (hpRatio < 0.3) score += 40;
  else if (hpRatio < 0.5) score += 20;
  else if (hpRatio < 0.75) score += 5;

  if (target === ag.lastAttacker) score += 25;
  if (target.botClass === 'sniper') score += 15;

  // Tunnel-visioned bots strongly stick with current target
  const tunnel = ag.personality ? ag.personality.tunnelVision : 0.4;
  if (target === ag.currentTarget) score += 20 + tunnel * 25;

  if (dist < 8) score += 15;

  if (ag.currentTarget && ag.currentTarget !== target) {
    const currentDist = ag.position.distanceTo(ag.currentTarget.position);
    if (currentDist < 15 && dist > 25) score -= 30;
  }

  const mem = ag.enemyMemory.get(target.name);
  if (mem && mem.confidence > 0.5) score += 10;

  // Third-partying bonus: wounded enemies are prime targets in BR
if (gameState.mode === 'br') {
  if (target.hp < target.maxHP * 0.4) score += 20;
  // If target just took damage from someone else, they're distracted
  if (target.lastAttacker && target.lastAttacker !== ag &&
      (gameState.worldElapsed - target.lastDamageTime) < 2) score += 25;
}

  // Grudge: prioritize the one who killed us
  if (ag.grudge === target) {
    const revenge = ag.personality ? ag.personality.revengeBias : 0.4;
    score += 30 * revenge;
  }

  return score;
}

export function findBestTarget(ag: TDMAgent): { target: TDMAgent | null; dist: number } {
  if (ag.currentTarget && !ag.currentTarget.isDead && canSee(ag, ag.currentTarget)) {
    const d = ag.position.distanceTo(ag.currentTarget.position);
    if (!shouldRunPerception(ag)) {
      return { target: ag.currentTarget, dist: d };
    }
  }

  let bestTarget: TDMAgent | null = null;
  let bestScore = -Infinity;
  let bestDist = Infinity;

  for (const other of gameState.agents) {
    if (other === ag || other.isDead) continue;
    if (!isEnemy(ag, other)) continue;
    if (!canSee(ag, other)) continue;

    const d = ag.position.distanceTo(other.position);
    const score = scoreTarget(ag, other, d);

    if (score > bestScore) {
      bestScore = score;
      bestTarget = other;
      bestDist = d;
    }
  }

  return { target: bestTarget, dist: bestDist };
}

export function countNearbyAllies(ag: TDMAgent, range: number): number {
  // BR and FFA are solo — no allies
  if (isFreeForAll()) return 0;
  let count = 0;
  const rangeSq = range * range;
  for (const ally of gameState.agents) {
    if (ally === ag || ally.isDead) continue;
    if (ally.team !== ag.team) continue;
    const dx = ag.position.x - ally.position.x;
    const dz = ag.position.z - ally.position.z;
    if (dx * dx + dz * dz < rangeSq) count++;
  }
  return count;
}
