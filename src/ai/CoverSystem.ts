import * as YUKA from 'yuka';
import { ARENA_MARGIN } from '@/config/constants';
import { gameState } from '@/core/GameState';
import { perf } from '@/core/PerfProfiler';
import { isOccluded } from './Perception';
import type { TDMAgent } from '@/entities/TDMAgent';
import { WEAPONS } from '@/config/weapons';

// ── Cached temporaries ──
const _toTarget = new YUKA.Vector3();
const _peekPos = new YUKA.Vector3();
const _midPos = new YUKA.Vector3();
const _navPos = new YUKA.Vector3();

/**
 * Check if a world position is inside any wall/pillar collider.
 */
export function isInsideWall(x: number, z: number): boolean {
  if (Math.abs(x) > ARENA_MARGIN || Math.abs(z) > ARENA_MARGIN) return true;

  if (gameState.navMeshManager.navMesh) {
    _navPos.set(x, 0, z);
    return !gameState.navMeshManager.getRegionForPoint(_navPos, 0.45);
  }

  for (const c of gameState.arenaColliders) {
    if (c.type === 'box') {
      if (Math.abs(x - c.x) < c.hw && Math.abs(z - c.z) < c.hd) return true;
    } else {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz < c.r * c.r) return true;
    }
  }
  return false;
}

/**
 * Push a position out of any wall it's inside. Returns a safe position.
 */
export function pushOutOfWall(x: number, z: number): { x: number; z: number } {
  if (gameState.navMeshManager.navMesh) {
    _navPos.set(x, 0, z);
    const projected = gameState.navMeshManager.projectPoint(_navPos, 0.45);
    x = projected.x;
    z = projected.z;
    x = Math.max(-ARENA_MARGIN + 1, Math.min(ARENA_MARGIN - 1, x));
    z = Math.max(-ARENA_MARGIN + 1, Math.min(ARENA_MARGIN - 1, z));
    return { x, z };
  }

  for (const c of gameState.arenaColliders) {
    if (c.type === 'box') {
      const dx = x - c.x;
      const dz = z - c.z;
      const ox = c.hw - Math.abs(dx);
      const oz = c.hd - Math.abs(dz);
      if (ox >= 0 && oz >= 0) {
        if (ox < oz) x = c.x + Math.sign(dx || 1) * (c.hw + 0.3);
        else z = c.z + Math.sign(dz || 1) * (c.hd + 0.3);
      }
    } else {
      const dx = x - c.x;
      const dz = z - c.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < c.r * c.r) {
        const dist = Math.sqrt(distSq) || 1;
        x = c.x + (dx / dist) * (c.r + 0.3);
        z = c.z + (dz / dist) * (c.r + 0.3);
      }
    }
  }
  x = Math.max(-ARENA_MARGIN + 1, Math.min(ARENA_MARGIN - 1, x));
  z = Math.max(-ARENA_MARGIN + 1, Math.min(ARENA_MARGIN - 1, z));
  return { x, z };
}

/**
 * Find the best cover point — improved scoring with:
 * - Occupancy: penalize if teammate already near this cover
 * - Exposure: count how many enemies could see the cover approach path
 * - Path cost: closer cover is more valuable
 * - Enemy firing lane: penalize cover that enemies can easily shoot at
 * - Safety while reaching: is the approach path exposed?
 */
export function findCoverFrom(ag: TDMAgent, threat: YUKA.Vector3): YUKA.Vector3 | null {
  perf.begin('cover.findCoverFrom');
  let bestCover: YUKA.Vector3 | null = null;
  let bestScore = -Infinity;

  for (const cp of gameState.coverPoints) {
    const distToAgent = ag.position.distanceTo(cp);
    const distToThreat = cp.distanceTo(threat);
    if (distToAgent > 35) continue;
    if (!isOccluded(cp, threat)) continue;

    // Base score: close to agent, far from threat
    let score = distToThreat * 0.3 - distToAgent * 0.7;

    // ── Occupancy penalty: other allies already using this cover ──
    for (const ally of gameState.agents) {
      if (ally === ag || ally.isDead || ally.team !== ag.team) continue;
      const allyDist = ally.position.distanceTo(cp);
      if (allyDist < 4) score -= 12;       // strong penalty — cover is occupied
      else if (allyDist < 8) score -= 4;    // mild crowding penalty
      // Also check if an ally has this as their current cover target
      if (ally.currentCover && ally.currentCover.distanceTo(cp) < 3) score -= 10;
    }

    // ── Nearby ally bonus (safety in numbers, but not overcrowded) ──
    let nearbyAllies = 0;
    for (const ally of gameState.agents) {
      if (ally === ag || ally.isDead || ally.team !== ag.team) continue;
      if (ally.position.distanceTo(cp) < 15) nearbyAllies++;
    }
    if (nearbyAllies === 1 || nearbyAllies === 2) score += 3;

    // ── Health pickup proximity bonus when HP is low ──
    if (ag.hp < ag.maxHP * 0.5) {
      for (const p of gameState.pickups) {
        if (!p.active || p.t !== 'health') continue;
        const dx = cp.x - p.x;
        const dz = cp.z - p.z;
        if (dx * dx + dz * dz < 144) score += 8; // within 12 units
      }
    }

    // ── Enemy proximity penalty ──
    for (const enemy of gameState.agents) {
      if (enemy.isDead || enemy.team === ag.team) continue;
      const enemyDist = enemy.position.distanceTo(cp);
      if (enemyDist < 6) score -= 20;
      else if (enemyDist < 12) score -= 8;
    }

    // ── Approach exposure penalty: is the path from agent to cover exposed? ──
    // Sample midpoint of approach path
    const midX = (ag.position.x + cp.x) * 0.5;
    const midZ = (ag.position.z + cp.z) * 0.5;
    _midPos.set(midX, 0, midZ);
    if (!isOccluded(_midPos, threat)) {
      score -= 6; // exposed approach
    }

    // ── Path cost: strongly prefer closer cover ──
    if (distToAgent < 5) score += 5;
    else if (distToAgent > 20) score -= 5;

    if (score > bestScore) {
      bestScore = score;
      bestCover = cp;
    }
  }

  perf.end('cover.findCoverFrom');
  return bestCover;
}

/**
 * Find aggressive cover — cover that still has a sightline to the target (peek potential).
 */
export function findPeekCover(ag: TDMAgent, targetPos: YUKA.Vector3): YUKA.Vector3 | null {
  perf.begin('cover.findPeekCover');
  let bestCover: YUKA.Vector3 | null = null;
  let bestScore = -Infinity;

  for (const cp of gameState.coverPoints) {
    const distToAgent = ag.position.distanceTo(cp);
    if (distToAgent > 25) continue;

    _toTarget.subVectors(targetPos, cp).normalize();
    _peekPos.set(cp.x + _toTarget.x * 2.5, 0, cp.z + _toTarget.z * 2.5);

    // The cover point itself should be occluded
    if (!isOccluded(cp, targetPos)) continue;
    // But the peek position should NOT be occluded
    if (isOccluded(_peekPos, targetPos)) continue;

    const distToTarget = cp.distanceTo(targetPos);
    let score = -distToAgent * 0.5;
    score -= Math.abs(distToTarget - ag.preferredRange) * 0.3;

    // Occupancy penalty
    for (const ally of gameState.agents) {
      if (ally === ag || ally.isDead || ally.team !== ag.team) continue;
      if (ally.currentCover && ally.currentCover.distanceTo(cp) < 4) score -= 10;
      if (ally.position.distanceTo(cp) < 4) score -= 8;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCover = cp;
    }
  }

  perf.end('cover.findPeekCover');
  return bestCover;
}

/**
 * Calculate a flanking position — circle around behind the target through cover.
 */
export function findFlankPosition(ag: TDMAgent, targetPos: YUKA.Vector3): YUKA.Vector3 | null {
  _toTarget.subVectors(targetPos, ag.position);
  const len = _toTarget.length();
  if (len < 1) return null;
  _toTarget.normalize();

  const side = Math.random() > 0.5 ? 1 : -1;
  const perpX = -_toTarget.z * side;
  const perpZ = _toTarget.x * side;

  const flankDist = 10 + Math.random() * 8;
  const behindDist = 5 + Math.random() * 5;

  let fx = targetPos.x + perpX * flankDist - _toTarget.x * behindDist;
  let fz = targetPos.z + perpZ * flankDist - _toTarget.z * behindDist;

  fx = Math.max(-ARENA_MARGIN, Math.min(ARENA_MARGIN, fx));
  fz = Math.max(-ARENA_MARGIN, Math.min(ARENA_MARGIN, fz));

  if (isInsideWall(fx, fz)) {
    const pushed = pushOutOfWall(fx, fz);
    fx = pushed.x;
    fz = pushed.z;
  }
  const flankPos = new YUKA.Vector3(fx, 0, fz);

  if (isOccluded(flankPos, targetPos)) {
    let altFx = targetPos.x - perpX * flankDist - _toTarget.x * behindDist;
    let altFz = targetPos.z - perpZ * flankDist - _toTarget.z * behindDist;
    altFx = Math.max(-ARENA_MARGIN, Math.min(ARENA_MARGIN, altFx));
    altFz = Math.max(-ARENA_MARGIN, Math.min(ARENA_MARGIN, altFz));
    if (isInsideWall(altFx, altFz)) {
      const pushed = pushOutOfWall(altFx, altFz);
      altFx = pushed.x;
      altFz = pushed.z;
    }
    return new YUKA.Vector3(altFx, 0, altFz);
  }

  return flankPos;
}

/**
 * Find a good sniper position — far from enemy, behind cover, with long sightlines.
 */
export function findSniperNest(ag: TDMAgent, targetPos: YUKA.Vector3): YUKA.Vector3 | null {
  perf.begin('cover.findSniperNest');
  let bestPos: YUKA.Vector3 | null = null;
  let bestScore = -Infinity;

  for (const cp of gameState.coverPoints) {
    const distToAgent = ag.position.distanceTo(cp);
    if (distToAgent > 40) continue;

    const distToTarget = cp.distanceTo(targetPos);
    if (distToTarget < 20 || distToTarget > 55) continue;

    _toTarget.subVectors(targetPos, cp).normalize();
    _peekPos.set(cp.x + _toTarget.x * 2, 0, cp.z + _toTarget.z * 2);

    if (isOccluded(_peekPos, targetPos)) continue;

    let score = distToTarget * 0.3 - distToAgent * 0.3;
    for (const enemy of gameState.agents) {
      if (enemy.isDead || enemy.team === ag.team) continue;
      if (enemy.position.distanceTo(cp) > 20) score += 5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPos = cp;
    }
  }

  perf.end('cover.findSniperNest');
  return bestPos;
}

/**
 * Find the nearest active pickup of a given type.
 * For 'weapon' type, finds the best upgrade available.
 * Uses agent's pickup cache when available to reduce redundant scanning.
 */
export function findNearestPickup(ag: TDMAgent, type: 'health' | 'ammo' | 'weapon'): YUKA.Vector3 | null {
  let bestPos: YUKA.Vector3 | null = null;
  let bestDist = Infinity;
  let bestScore = -Infinity;

  for (const p of gameState.pickups) {
    if (!p.active) continue;

    if (type === 'weapon') {
      if (p.t !== 'weapon' || !p.weaponId) continue;
      const wep = WEAPONS[p.weaponId];
      if (!wep) continue;
      const cur = WEAPONS[ag.weaponId];
      // If unarmed, any weapon is desirable
      if (ag.weaponId !== 'unarmed' && wep.desirability <= cur.desirability) continue;
      const d = ag.position.distanceTo(new YUKA.Vector3(p.x, 0, p.z));
      const desirabilityDiff = ag.weaponId === 'unarmed' ? 100 : wep.desirability - cur.desirability;
      const score = desirabilityDiff - d * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestPos = new YUKA.Vector3(p.x, 0, p.z);
      }
    } else {
      if (p.t !== type) continue;
      const dx = ag.position.x - p.x;
      const dz = ag.position.z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) {
        bestDist = d;
        bestPos = new YUKA.Vector3(p.x, 0, p.z);
      }
    }
  }

  return bestPos;
}
