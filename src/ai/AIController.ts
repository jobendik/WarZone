import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import { TEAM_BLUE } from '@/config/constants';
import type { TDMAgent } from '@/entities/TDMAgent';
import {
  findBestTarget, canSee, checkAudioAwareness,
  countNearbyAllies, updateEnemyMemory, decayEnemyMemory,
  isOccluded,
} from './Perception';
import { evalFuzzy } from './FuzzyLogic';
import { findCoverFrom, pushOutOfWall } from './CoverSystem';
import { hitscanShot, shotgunBlast, spawnRocket, spawnGrenade } from '@/combat/Hitscan';
import { spawnMuzzleFlash } from '@/combat/Particles';
import { keepInside, getFloorY } from '@/entities/Player';
import { updateAim, getAimDirection } from './HumanAim';
import { playFootstep, playBotCallout, playReload } from '@/audio/SoundHooks';
import { CLASS_CONFIGS } from '@/config/classes';
import { WEAPONS, CLASS_DEFAULT_WEAPON, type WeaponId } from '@/config/weapons';

// Bot footstep timers (keyed by agent name)
const _footstepTimers = new Map<string, number>();

/** Clear footstep timers (call on match reset). */
export function clearFootstepTimers(): void { _footstepTimers.clear(); }
import { deliverPendingCallouts, queueCallout } from './TeamIntel';
import { BotVoice, type CalloutSource } from '@/ai/BotVoice';

function agentToCalloutSource(ag: TDMAgent): CalloutSource {
  return {
    id: ag.name,
    name: ag.name,
    team: ag.team === 0 ? 'blue' : 'red',
    position: new THREE.Vector3(ag.position.x, 0, ag.position.z),
    personality: ag.personality ? { chatter: ag.personality.aggressionBias } : undefined,
  };
}
import { shouldBotHesitate, getGlanceDirection } from './ContextualPerception';
import type { TeamIntent } from './AITypes';

const _pinchTarget = new YUKA.Vector3();

// ═══════════════════════════════════════════
//  TEAM TACTICAL BOARD
// ═══════════════════════════════════════════
interface TeamBoard {
  intent: TeamIntent;
  lastUpdate: number;
  focusPos: YUKA.Vector3 | null;
  pressure: number;
}

const teamBoards: Record<number, TeamBoard> = {
  0: { intent: 'hold', lastUpdate: -10, focusPos: null, pressure: 0 },
  1: { intent: 'hold', lastUpdate: -10, focusPos: null, pressure: 0 },
};

function updateTeamBoard(teamId: number): void {
  const now = gameState.worldElapsed;
  const board = teamBoards[teamId];
  if (now - board.lastUpdate < 2) return; // update every 2 seconds
  board.lastUpdate = now;

  const allies = gameState.agents.filter(a => a.team === teamId && !a.isDead && a !== gameState.player);
  const enemies = gameState.agents.filter(a => a.team !== teamId && !a.isDead);
  if (allies.length === 0) return;

  // ── Trade-frag coordination ──
  // For each bot engaging a target, nearby allies get a hint to approach from a different angle
  for (const ally of allies) {
    (ally as any)._tradeAngleOffset = 0;
  }
  for (const ally of allies) {
    if (!ally.currentTarget || ally.currentTarget.isDead) continue;
    const tgtPos = ally.currentTarget.position;
    const allyAngle = Math.atan2(ally.position.x - tgtPos.x, ally.position.z - tgtPos.z);

    for (const nearby of allies) {
      if (nearby === ally) continue;
      if (nearby.position.distanceTo(ally.position) > 25) continue;
      // Give nearby bots a perpendicular offset angle relative to the engaging ally's angle
      const side = nearby.strafeDir > 0 ? 1 : -1;
      (nearby as any)._tradeAngleOffset = allyAngle + side * (Math.PI * 0.4 + Math.random() * 0.3);
    }
  }

  // Calculate team health and pressure
  const avgHP = allies.reduce((s, a) => s + a.hp / a.maxHP, 0) / allies.length;
  const aliveEnemies = enemies.length;
  const aliveAllies = allies.length;
  const scoreDiff = gameState.teamScores[teamId] - gameState.teamScores[teamId === 0 ? 1 : 0];

  board.pressure = Math.max(0, Math.min(1, (aliveEnemies - aliveAllies) / 5 + (1 - avgHP)));

  // Focus pos: average of all known enemy positions
  let fx = 0, fz = 0, fcount = 0;
  for (const ally of allies) {
    for (const [, mem] of ally.enemyMemory) {
      if (mem.confidence > 0.3) {
        fx += mem.lastSeenPos.x;
        fz += mem.lastSeenPos.z;
        fcount++;
      }
    }
  }
  if (fcount > 0) {
    if (!board.focusPos) board.focusPos = new YUKA.Vector3();
    board.focusPos.set(fx / fcount, 0, fz / fcount);
  }

  // Determine team intent
  if (avgHP < 0.35 || board.pressure > 0.7) {
    board.intent = 'reset';
  } else if (scoreDiff < -3 && avgHP > 0.6) {
    board.intent = 'hunt';
  } else if (aliveAllies > aliveEnemies + 1 && avgHP > 0.5) {
    board.intent = 'collapse';
  } else if (scoreDiff > 3) {
    board.intent = 'hold';
  } else {
    board.intent = Math.random() < 0.5 ? 'hold' : 'hunt';
  }

  // Apply team intent to agents' aggression
  for (let i = 0; i < allies.length; i++) {
    const ally = allies[i];
    switch (board.intent) {
      case 'hunt':
        ally.fuzzyAggr = Math.min(100, ally.fuzzyAggr + 10);
        break;
      case 'collapse':
        ally.fuzzyAggr = Math.min(100, ally.fuzzyAggr + 10);
        // Assign unique approach angle for coordinated pinch
        if (board.focusPos) {
          const angleStep = (Math.PI * 2) / allies.length;
          const angle = angleStep * i;
          const pinchDist = 8;
          const px = board.focusPos.x + Math.cos(angle) * pinchDist;
          const pz = board.focusPos.z + Math.sin(angle) * pinchDist;
          (ally as any)._pinchTarget = _pinchTarget.set(px, 0, pz).clone();
        }
        break;
      case 'reset':
        ally.fuzzyAggr = Math.max(0, ally.fuzzyAggr - 15);
        (ally as any)._pinchTarget = null;
        break;
      default:
        (ally as any)._pinchTarget = null;
        break;
    }
  }
}

const _muzzlePos = new THREE.Vector3();

// ═══════════════════════════════════════════
//  BOT WEAPON SWAP — range-based secondary switching
// ═══════════════════════════════════════════
function botTryWeaponSwap(ag: TDMAgent, dist: number): void {
  if (ag.weaponSwapCooldown > 0) return;
  if (ag.isReloading) return;
  if (ag.weaponId === 'unarmed' || ag.weaponId === 'knife') return;

  const current = WEAPONS[ag.weaponId];
  const secondary = WEAPONS[ag.secondaryWeaponId];
  if (!current || !secondary) return;

  let shouldSwap = false;

  if (ag.weaponId !== ag.secondaryWeaponId) {
    if ((ag.weaponId === 'sniper_rifle' || ag.weaponId === 'rocket_launcher') && dist < 8) {
      shouldSwap = true;
    }
    if (ag.ammo <= 0 && !ag.isReloading) {
      shouldSwap = true;
    }
  } else {
    const primary = WEAPONS[CLASS_DEFAULT_WEAPON[ag.botClass] || 'assault_rifle'];
    if (primary && dist > 15 && ag.weaponId === ag.secondaryWeaponId) {
      shouldSwap = true;
    }
  }

  if (shouldSwap) {
    const targetWeapon: WeaponId = ag.weaponId === ag.secondaryWeaponId
      ? (CLASS_DEFAULT_WEAPON[ag.botClass] || 'assault_rifle') as WeaponId
      : ag.secondaryWeaponId;
    const def = WEAPONS[targetWeapon];
    ag.weaponId = targetWeapon;
    ag.damage = def.damage;
    ag.fireRate = def.fireRate;
    ag.burstSize = def.burstSize;
    ag.burstDelay = def.burstDelay;
    ag.reloadTime = def.reloadTime;
    ag.magSize = def.magSize;
    ag.ammo = Math.ceil(def.magSize * 0.5);
    ag.aimError = def.aimError;
    ag.weaponSwapCooldown = 3;
    ag.shootTimer = 0.5;
  }
}



let _lastCalloutFrame = -1;
function deliverCalloutsOncePerFrame(): void {
  if (_lastCalloutFrame !== gameState.perceptionFrame) {
    _lastCalloutFrame = gameState.perceptionFrame;
    deliverPendingCallouts();
  }
}

/** Fire the agent's weapon using the simulated crosshair direction.
 *  PERF/FIX: before firing, check if the aim ray hits a wall before the
 *  target. This prevents bots from shooting through walls/crates (they
 *  could see the target last frame, aim toward it, but the target moved
 *  behind cover by the time the burst fires). */
function aiShoot(ag: TDMAgent): void {
  if (ag.isDead || !ag.currentTarget || ag.currentTarget.isDead) return;
  if (ag.weaponId === 'unarmed') return;

  const { dir, origin } = getAimDirection(ag);

  // Wall-block check: cast a quick ray along the firing direction and
  // confirm the target isn't behind a wall. Without this, bots fire
  // through crates/walls whenever their aim spring leads ahead of LOS.
  const tgt = ag.currentTarget;
  const distToTarget = Math.sqrt(
    (tgt.position.x - origin.x) ** 2 + (tgt.position.z - origin.z) ** 2,
  );
  _muzzlePos.set(origin.x, origin.y, origin.z);
  const rc = gameState.raycaster;
  rc.set(_muzzlePos, dir);
  rc.near = 0;
  rc.far = distToTarget;
  const wallHits = rc.intersectObjects(gameState.wallMeshes, false);
  if (wallHits.length > 0 && wallHits[0].distance < distToTarget * 0.92) {
    return; // aim ray hits a wall before reaching the target — don't fire
  }

  const col = ag.team === TEAM_BLUE ? 0x60a5fa : 0xff6644;

  _muzzlePos.set(origin.x + dir.x * 0.6, 1.0, origin.z + dir.z * 0.6);
  spawnMuzzleFlash(_muzzlePos, col);

  // PERF: pass dir/origin by reference — getAimDirection returns shared
  // scratches, and hitscanShot/shotgunBlast both copy-on-entry into
  // their own module scratches, so no retained reference leaks.
  if (ag.weaponId === 'shotgun') {
    shotgunBlast(origin, dir, 'ai', ag.team, col, ag);
  } else if (ag.weaponId === 'rocket_launcher') {
    spawnRocket(origin, dir, 'ai', ag.team, col, ag);
  } else {
    hitscanShot(origin, dir, 'ai', ag.team, ag.weaponId, col, ag);
  }
  ag.ammo--;
}

function updateStrafing(ag: TDMAgent, dt: number): void {
  ag.strafeTimer -= dt;
  if (ag.strafeTimer > 0) return;

  const p = ag.personality;
  const repos = p ? p.repositionFrequency : 0.5;

  const baseInterval = 0.3 + (1 - repos) * 0.7;
  const flipChance = 0.4 + repos * 0.4;

  if (Math.random() < flipChance) ag.strafeDir *= -1;
  ag.strafeTimer = baseInterval * (0.6 + Math.random() * 0.8);
}

function updateDamagePressure(ag: TDMAgent, dt: number): void {
  const timeSinceDamage = gameState.worldElapsed - ag.lastDamageTime;
  const p = ag.personality;

  if (timeSinceDamage < 0.3) {
    ag.strafeDir *= -1;
    ag.strafeTimer = 0.4;
  }

  const recentDamageRatio = ag.recentDamage / ag.maxHP;
  const recency = Math.max(0, 1 - timeSinceDamage / 3);
  const baseP = recentDamageRatio * recency * 2;
  const flinch = p ? p.flinchFactor : 0.3;
  ag.pressureLevel = Math.min(1, baseP * (0.8 + flinch * 0.6));
  ag.underPressure = ag.pressureLevel > 0.25;

  if (ag.pressureLevel > 0.5 && ag.shootTimer < 0.1 && p) {
    if (p.panicSprayFactor < 0.5) {
      ag.shootTimer += ag.pressureLevel * 0.08;
    }
  }

  if (ag.underPressure) {
    ag.fuzzyAggr = Math.max(0, ag.fuzzyAggr - ag.pressureLevel * 25);
  }

  ag.recentDamage = Math.max(0, ag.recentDamage - dt * 20);
}

function updateTilt(ag: TDMAgent, dt: number): void {
  if (ag.tiltLevel > 0) {
    ag.tiltLevel = Math.max(0, ag.tiltLevel - dt * 0.05);
  }
  if (ag.grudge && gameState.worldElapsed > ag.grudgeExpiry) {
    ag.grudge = null;
  }
}

function tryThrowGrenade(ag: TDMAgent, target: TDMAgent, dist: number): boolean {
  if (ag.grenades <= 0 || ag.grenadeCooldown > 0) return false;
  if (dist < 5 || dist > 30) return false;

  const p = ag.personality;
  const aggroMul = p ? (1 + p.aggressionBias * 0.5) : 1;

  const shouldThrow =
    (dist > 10 && dist < 25 && ag.stateName === 'COVER') ||
    (ag.nearbyAllies >= 2 && ag.confidence > 50 && Math.random() < 0.04 * aggroMul) ||
    (ag.stateName === 'ENGAGE' && dist > 12 && Math.random() < 0.02 * aggroMul);

  if (!shouldThrow) return false;

  const o = new THREE.Vector3(ag.position.x, 1.2, ag.position.z);
  const tPos = new THREE.Vector3(target.position.x, 0, target.position.z);
  const d = tPos.clone().sub(o).normalize();
  const throwNoise = 0.08 + (p ? (1 - p.skill) * 0.15 : 0.07);
  d.x += (Math.random() - 0.5) * throwNoise;
  d.z += (Math.random() - 0.5) * throwNoise;
  d.normalize();

  spawnGrenade(o, d, 'ai', ag.team, ag);
  // BotVoice — grenade callout
  BotVoice.onGrenade(agentToCalloutSource(ag), false);
  ag.grenades--;
  ag.grenadeCooldown = 8 + Math.random() * 4;
  return true;
}

function shouldReplan(ag: TDMAgent): boolean {
  if (gameState.worldElapsed >= ag.commitmentUntil) return true;
  if (ag.currentTarget?.isDead) return true;
  if (ag.recentDamage > ag.maxHP * 0.3) return true;
  return false;
}

function setCommitment(ag: TDMAgent, seconds: number): void {
  ag.commitmentUntil = gameState.worldElapsed + seconds;
}

const _footstepPos = new THREE.Vector3();
function updateBotFootsteps(ag: TDMAgent, dt: number): void {
  const speed = ag.velocity.length();
  if (speed < 1.5) return; // too slow / crouching — silent
  const interval = speed > 8 ? 0.28 : 0.42; // faster cadence when sprinting
  let timer = _footstepTimers.get(ag.name) ?? 0;
  timer -= dt;
  if (timer <= 0) {
    _footstepPos.set(ag.position.x, ag.position.y, ag.position.z);
    playFootstep(_footstepPos, false);
    timer = interval;
  }
  _footstepTimers.set(ag.name, timer);
}

export function updateAI(ag: TDMAgent, dt: number): void {
  if (ag === gameState.player || ag.isDead) return;

  deliverCalloutsOncePerFrame();
  // Team coordination — update board once per frame per team
  if (gameState.mode !== 'ffa' && gameState.mode !== 'br') {
    updateTeamBoard(ag.team);
  }

  ag.stateTime += dt;
  updateBotFootsteps(ag, dt);
  updateStrafing(ag, dt);
  updateDamagePressure(ag, dt);
  // BotVoice — low HP callout (throttled via flag on agent)
  if (ag.hp / ag.maxHP < 0.3 && !(ag as any)._lowHpBVCalled) {
    (ag as any)._lowHpBVCalled = true;
    BotVoice.onLowHp(agentToCalloutSource(ag), ag.hp / ag.maxHP <= 0.15);
  } else if (ag.hp / ag.maxHP >= 0.5) {
    (ag as any)._lowHpBVCalled = false;
  }
  updateTilt(ag, dt);
  decayEnemyMemory(ag, dt);
  updateAim(ag, dt);

  if (gameState.pDead && ag.currentTarget === gameState.player) {
    ag.currentTarget = null;
    ag.hasTarget = false;
    ag.trackingTime = 0;
    ag.burstCount = 0;
  }

  // Stuck detection
  const movedDist = ag.position.distanceTo(ag.lastStuckCheckPos);
  if (movedDist < 0.15) ag.stuckTime += dt;
  else ag.stuckTime = 0;

  if (Math.random() < 0.1) ag.lastStuckCheckPos.copy(ag.position);
  if (ag.stuckTime > 0.8) {
    ag.stuckTime = 0;
    ag.hasLastKnown = false;
    ag.currentCover = null;
    ag.seekingPickup = false;
    ag.seekPickupPos = null;
    ag.navRuntime.clearPath();
    const pushed = pushOutOfWall(ag.position.x, ag.position.z);
    if (ag.seekB) {
      (ag.seekB as any).target.set(
        pushed.x + (Math.random() - 0.5) * 4,
        0,
        pushed.z + (Math.random() - 0.5) * 4,
      );
      ag.seekB.weight = 2;
    }
    ag.stateName = 'PATROL';
    ag.brain.clearSubgoals();
    ag.brain.arbitrate();
    setCommitment(ag, 1.5);
  }

  if (ag.grenadeCooldown > 0) ag.grenadeCooldown -= dt;
  if (ag.weaponSwapCooldown > 0) ag.weaponSwapCooldown -= dt;

  checkAudioAwareness(ag);

  // Check-your-six: idle bots periodically glance around
  if (!ag.hasTarget) {
    const glance = getGlanceDirection(ag);
    if (glance) {
      const gd = glance.clone().multiplyScalar(10);
      ag.lastKnownPos.set(ag.position.x + gd.x, 0, ag.position.z + gd.z);
      ag.hasLastKnown = true;
    }
  }

  // Pre-aim: if we have enemy memory, aim toward most likely threat direction
  if (!ag.hasTarget && ag.personality && ag.personality.preAimBias > 0.2) {
    let bestConf = 0;
    let bestPos: YUKA.Vector3 | null = null;
    for (const [, entry] of ag.enemyMemory) {
      if (entry.confidence > bestConf) {
        bestConf = entry.confidence;
        bestPos = entry.lastSeenPos;
      }
    }
    if (bestPos && bestConf > 0.15) {
      ag.preAimPos = bestPos;
    } else {
      // Pre-aim toward center of arena / common engagement areas
      const teamBoard = teamBoards[ag.team];
      if (teamBoard.focusPos) {
        ag.preAimPos = teamBoard.focusPos;
      } else {
        ag.preAimPos = null;
      }
    }
  }

  ag.allyCheckTimer -= dt;
  if (ag.allyCheckTimer <= 0) {
    ag.allyCheckTimer = 0.8 + Math.random() * 0.4;
    ag.nearbyAllies = countNearbyAllies(ag, 20);
  }

  const { target, dist } = findBestTarget(ag);
  const hadTarget = ag.hasTarget;

  if (target) {
    const prevTarget = ag.currentTarget;
    ag.currentTarget = target;
    ag.lastKnownPos.copy(target.position);
    ag.hasLastKnown = true;
    ag.alertLevel = Math.min(100, ag.alertLevel + dt * 30);

    updateEnemyMemory(ag, target, 'visual');

    if (!hadTarget || prevTarget !== target) {
      queueCallout(ag, target);
    }

    if (hadTarget && prevTarget === target) ag.trackingTime += dt;
    else ag.trackingTime = 0;

    if (!hadTarget) {
      const p = ag.personality;
      const skillMod = p ? (1.3 - p.skill * 0.6) : 1.0;
      const tiltMod = 1 + ag.tiltLevel * 0.4;
      ag.reactionTimer = ag.reactionTime * skillMod * tiltMod * (0.7 + Math.random() * 0.6);
      // Contextual hesitation: surprise, low ammo, health disadvantage
      ag.reactionTimer += shouldBotHesitate(ag, target);
      ag.hasTarget = true;
      // BotVoice — spot enemy callout
      BotVoice.onSpotEnemy(agentToCalloutSource(ag), ag.weaponId === 'sniper_rifle', false);
    }
    ag.reactionTimer = Math.max(0, ag.reactionTimer - dt);

    if (ag.pursuitB && target) (ag.pursuitB as any).evader = target;

    evalFuzzy(ag, dist);
    botTryWeaponSwap(ag, dist);

    const canReact = ag.reactionTimer <= 0;

    if (ag.underPressure && ag.hp < ag.maxHP * 0.55) {
      ag.currentCover = ag.currentTarget ? findCoverFrom(ag, ag.currentTarget.position) : ag.currentCover;
    }

    // Decision making with commitment
    ag.decisionTimer -= dt;
    if (ag.decisionTimer <= 0 && shouldReplan(ag)) {
      const baseInterval = ag.underPressure ? 0.1 + Math.random() * 0.1 : 0.2 + Math.random() * 0.25;
      const p = ag.personality;
      const commitScale = p ? (1 + p.patienceBias) : 1;
      ag.decisionTimer = baseInterval * commitScale;

      const myTeamScore = gameState.teamScores[ag.team];
      const enemyTeamScore = gameState.teamScores[ag.team === TEAM_BLUE ? 1 : 0];
      const scoreDiff = myTeamScore - enemyTeamScore;
      if (scoreDiff < -3) ag.fuzzyAggr = Math.min(100, ag.fuzzyAggr + 15);
      if (scoreDiff > 5 && ag.hp / ag.maxHP < 0.5) ag.fuzzyAggr = Math.max(0, ag.fuzzyAggr - 10);

      ag.brain.arbitrate();
      const baseCommit = 0.6 + (p?.patienceBias ?? 0) * 0.8;
      setCommitment(ag, Math.max(0.3, baseCommit));
    }

    // ── Shooting ──
    if (ag.weaponId === 'unarmed') {
      // unarmed: cannot shoot
    } else if (canReact && canSee(ag, target)) {
      if (dist > 10 && ag.grenadeCooldown <= 0 && ag.grenades > 0) {
        tryThrowGrenade(ag, target, dist);
      }

      if (ag.isReloading) {
        ag.reloadTimer -= dt;
        if (ag.reloadTimer <= 0) {
          ag.isReloading = false;
          ag.ammo = ag.magSize;
        }
      } else if (ag.ammo <= 0) {
        ag.isReloading = true;
        ag.reloadTimer = ag.reloadTime;
        playReload(false, false, new THREE.Vector3(ag.position.x, 1.2, ag.position.z), ag.weaponId);
        // BotVoice — reload callout
        BotVoice.onReload(agentToCalloutSource(ag));
        if (ag.team === gameState.player.team) {
          const distToPlayer = ag.position.distanceTo(gameState.player.position);
          if (distToPlayer < 25 && Math.random() < 0.3) {
            const pitch = ag.personality ? 0.85 + ag.personality.aggressionBias * 0.3 : 1;
            playBotCallout('reload', new THREE.Vector3(ag.position.x, 1.6, ag.position.z), pitch);
            // Low-HP help callout
            if (ag.hp / ag.maxHP < 0.3 && ag.hasTarget && Math.random() < 0.15) {
              playBotCallout('help', new THREE.Vector3(ag.position.x, 1.6, ag.position.z), pitch);
            }
          }
        }
        if (ag.stateName !== 'COVER' && ag.stateName !== 'RETREAT') {
          const cover = findCoverFrom(ag, target.position);
          if (cover) ag.currentCover = cover;
        }
      } else {
        // Panic skip — only when heavily pressured AND personality is disciplined
        const p = ag.personality;
        const pressureSkip =
          ag.pressureLevel > 0.7 &&
          p !== null &&
          Math.random() < ag.pressureLevel * 0.3 * (1 - p.panicSprayFactor);

        if (!pressureSkip) {
          ag.shootTimer -= dt;
          if (ag.shootTimer <= 0) {
            // Personality-modulated burst size
            const effectiveBurst = p
              ? Math.max(1, Math.round(ag.burstSize * (1 + (Math.random() - 0.5) * p.burstLengthVariance * 0.8)))
              : ag.burstSize;

            if (ag.burstCount < effectiveBurst) {
              ag.burstTimer -= dt;
              if (ag.burstTimer <= 0) {
                aiShoot(ag);
                ag.burstCount++;
                ag.burstTimer = ag.burstDelay;
              }
            } else {
              ag.burstCount = 0;
              // Disciplined bots pause longer between bursts
              const discPause = p ? (p.triggerDiscipline * 0.15) : 0.05;
              ag.shootTimer = ag.fireRate + discPause + Math.random() * 0.12;
            }
          }
        }
      }
    } else if (canReact && ag.hasLastKnown && ag.alertLevel > 60 && !ag.isReloading && ag.ammo > 3) {
      // Suppressive fire — only if there's a clear shot toward last known position
      // (prevents shooting through walls/crates)
      const hasLOS = !isOccluded(ag.position, ag.lastKnownPos);
      if (hasLOS) {
        const p = ag.personality;
        const suppress = p ? (0.25 + p.trigHappy * 0.4) : 0.3;
        if (!ag.underPressure || Math.random() < 0.15) {
          const timeSinceTarget = ag.stateTime;
          if (timeSinceTarget < 1.5 && Math.random() < suppress) {
            ag.shootTimer -= dt;
            if (ag.shootTimer <= 0) {
              const { dir, origin } = getAimDirection(ag);
              const col = ag.team === TEAM_BLUE ? 0x60a5fa : 0xff6644;
              _muzzlePos.set(origin.x + dir.x * 0.6, 1.0, origin.z + dir.z * 0.6);
              spawnMuzzleFlash(_muzzlePos, col);
              hitscanShot(origin, dir, 'ai', ag.team, ag.weaponId, col, ag);
              ag.ammo--;
              ag.shootTimer = ag.fireRate * 1.5;
            }
          }
        }
      }
    }
  } else {
    // No target
    ag.hasTarget = false;
    ag.currentTarget = null;
    ag.trackingTime = 0;
    ag.alertLevel = Math.max(0, ag.alertLevel - dt * 15);

    // Smart reload — top up the magazine when no enemy visible and ammo < 60%
    if (!ag.isReloading && ag.weaponId !== 'unarmed' && ag.weaponId !== 'knife') {
      if (ag.ammo < ag.magSize * 0.6 && Math.random() < 0.02) {
        ag.isReloading = true;
        ag.reloadTimer = ag.reloadTime;
        playReload(false, false, new THREE.Vector3(ag.position.x, 1.2, ag.position.z), ag.weaponId);
      }
    }

    const timeSinceDmg = gameState.worldElapsed - ag.lastDamageTime;
    if (timeSinceDmg < 1.5 && ag.lastAttacker && !ag.lastAttacker.isDead) {
      ag.lastKnownPos.copy(ag.lastAttacker.position);
      ag.hasLastKnown = true;
      ag.alertLevel = 80;
    }

    if (!ag.hasLastKnown) {
      let bestMemConf = 0;
      let bestMemPos: YUKA.Vector3 | null = null;
      for (const [, entry] of ag.enemyMemory) {
        if (entry.confidence > bestMemConf && entry.confidence > 0.2) {
          bestMemConf = entry.confidence;
          bestMemPos = entry.lastSeenPos;
        }
      }
      if (bestMemPos) {
        ag.lastKnownPos.copy(bestMemPos);
        ag.hasLastKnown = true;
        ag.alertLevel = Math.max(ag.alertLevel, 40);
      }
    }

    ag.decisionTimer -= dt;
    if (ag.decisionTimer <= 0 && shouldReplan(ag)) {
      ag.decisionTimer = 0.3 + Math.random() * 0.3;
      ag.brain.arbitrate();
      setCommitment(ag, 0.8);
    }
  }

  ag.brain.execute();

  // ── Bot crouch speed modifier ──
  // When crouching, reduce speed to 55% of class baseline (matches player CROUCH_SPEED_MULT)
  const cfg = CLASS_CONFIGS[ag.botClass];
  if (cfg) {
    if (ag.isBotCrouching) {
      ag.maxSpeed = Math.min(ag.maxSpeed, cfg.maxSpeed * 0.55);
    } else if (ag.maxSpeed < cfg.maxSpeed && ag.stateName !== 'PATROL' && ag.stateName !== 'FLANK' && ag.stateName !== 'RETREAT') {
      // Restore base speed when not crouching (goals like PATROL/FLANK/RETREAT manage their own speed)
      ag.maxSpeed = cfg.maxSpeed;
    }
  }

  // Passive spawn-heal only in arena modes (not BR — spawn positions are random)
  if (gameState.mode !== 'br' && ag.position.distanceTo(ag.spawnPos) < 8) {
    ag.hp = Math.min(ag.maxHP, ag.hp + dt * 15);
  }

  // NavMesh clamping is handled by GameLoop after entityManager.update() moves entities.
  if (!gameState.navMeshManager.navMesh) {
    keepInside(ag);
  }
}
