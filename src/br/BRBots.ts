/**
 * BRBots — Battle-royale bot system.
 *
 * This rewrite adds true agency. Bots:
 *   • See each other across the map (BR-extended perception)
 *   • Assess fights before engaging (winProbability, range fit)
 *   • Heal/shield between fights like a real player
 *   • Third-party ongoing fights to steal kills
 *   • Seek elevation + cover in the endgame instead of running in circles
 *   • Squad up with same-team bots when nearby
 *   • Rotate early and aggressively when the zone pressures them
 *
 * Phases:
 *   inactive | storm_flee | retreating | loot_urgent | loot_safe
 *   heal_up  | third_party | rotating | hunting | engaging | endgame_hold
 *
 * The 'engaging' phase yields steering to updateAI (combat goals own it).
 * All other phases explicitly override steering.
 */

import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import { TEAM_BLUE, TEAM_RED, TEAM_COLORS } from '@/config/constants';
import { CLASS_CONFIGS, type BotClass } from '@/config/classes';
import { TDMAgent } from '@/entities/TDMAgent';
import { buildSoldierMesh } from '@/rendering/SoldierMesh';
import { makeNameTag, disposeNameTag } from '@/rendering/NameTag';
import { addHPBar, disposeHPBar } from '@/rendering/HPBar';
import {
  attachBlueSwatCharacter, attachEnemyCharacter,
  hasBlueSwatAssets, hasEnemyAssets,
} from '@/rendering/AgentAnimations';
import { setupFuzzy } from '@/ai/FuzzyLogic';
import { makePersonality } from '@/ai/Personality';
import { NavAgentRuntime } from '@/ai/navigation/NavAgentRuntime';
import {
  PatrolState, EngageState, InvestigateState, RetreatState,
  CoverState, FlankState, SeekPickupState, TeamPushState, PeekState,
} from '@/ai/states';
import {
  AttackEvaluator, SurviveEvaluator, ReloadEvaluator,
  SeekHealthEvaluator, GetWeaponEvaluator, HuntEvaluator, PatrolEvaluator,
} from '@/ai/goals/Evaluators';
import {
  BR_TOTAL_PLAYERS, AI_LOD_TIER1, AI_LOD_TIER2, AI_LOD_TIER3,
  BR_MAP_HALF,
} from './BRConfig';
import { zone, isOutsideZone, distanceToZoneEdge } from './ZoneSystem';
import { lootGrid, removeGroundLoot } from './LootSystem';
import { WEAPONS } from '@/config/weapons';
import { SpatialGrid } from './SpatialGrid';
import { buildingGrid, getBRMapData } from './BRMap';
import { findCoverFrom, pushOutOfWall } from '@/ai/CoverSystem';
import {
  findNearbyFight, decideEngagement, shouldHealUp, doHealUp,
  findEndgameHold,
} from './BRBrain';

export const botGrid = new SpatialGrid<TDMAgent>();

const SKELETAL_ACTIVATION_DIST = 90;
const SKELETAL_DEACTIVATION_DIST = 120;
const SPAWN_CHUNK_SIZE = 4;

// Shorter suppression window — bots start engaging earlier for action
const COMBAT_SUPPRESS_MIN_S = 10;
const COMBAT_SUPPRESS_MAX_S = 16;

export type BRBotPhase =
  | 'inactive'
  | 'loot_urgent'
  | 'loot_safe'
  | 'heal_up'
  | 'third_party'
  | 'rotating'
  | 'hunting'
  | 'engaging'
  | 'retreating'
  | 'storm_flee'
  | 'endgame_hold';

export interface BRBotState {
  phase: BRBotPhase;
  phaseStart: number;
  lodTier: 0 | 1 | 2 | 3;

  lootTargetId: number | null;
  poiTarget: { x: number; z: number } | null;
  poiTargetSetAt: number;

  hasLooted: boolean;

  stuckTimer: number;
  lastX: number;
  lastZ: number;

  skeletalAttached: boolean;
  skeletalLastFlipAt: number;

  combatSuppressUntil: number;
  lastPhaseDecision: number;

  /** Target position for current third-party approach */
  thirdPartyPos: { x: number; z: number } | null;
  thirdPartyExpiresAt: number;

  /** Cached endgame hold point */
  endgameHold: YUKA.Vector3 | null;
  endgameHoldSetAt: number;
}

const BOT_NAMES = [
  'Reaper','Wraith','Phantom','Viper','Ghost','Shade','Raven','Jackal',
  'Cobra','Hawk','Wolf','Lynx','Tiger','Panther','Falcon','Eagle',
  'Owl','Crow','Badger','Drake','Kodiak','Mako','Orion','Nova',
  'Pulse','Flux','Surge','Vex','Riot','Havoc','Storm','Ember',
];

export function getBRState(ag: TDMAgent): BRBotState | null {
  return (ag as any)._brState ?? null;
}

function syncRC(entity: YUKA.GameEntity, renderComponent: THREE.Object3D): void {
  renderComponent.position.copy(entity.position as unknown as THREE.Vector3);
  renderComponent.quaternion.copy(entity.rotation as unknown as THREE.Quaternion);
}

function buildPlaceholderMesh(team: 0 | 1, cls: BotClass): THREE.Group {
  return buildSoldierMesh(TEAM_COLORS[team], cls, team);
}

function mkBot(name: string, cls: BotClass, x: number, z: number): TDMAgent {
  const team = Math.random() < 0.5 ? TEAM_BLUE : TEAM_RED;
  const ag = new TDMAgent(name, team, cls);
  ag.position.set(x, 0, z);
  ag.spawnPos.set(x, 0, z);

  const personality = makePersonality(cls);
  ag.personality = personality;
  ag.reactionTime = Math.max(0.12, ag.reactionTime + personality.reactionModifier);

  const root = new THREE.Group();
  root.name = `${name}_R`;
  gameState.scene.add(root);
  ag.renderComponent = root;
  ag.setRenderComponent(root, syncRC);

  root.add(buildPlaceholderMesh(team, cls));

  const tag = makeNameTag(name, TEAM_COLORS[team]);
  tag.position.y = 2.6;
  root.add(tag);
  ag.nameTag = tag;
  addHPBar(ag);

  ag.wanderB = new YUKA.WanderBehavior(1.0, 4, 2.2);
  ag.arriveB = new YUKA.ArriveBehavior(new YUKA.Vector3(), 3, 0.5);
  ag.seekB = new YUKA.SeekBehavior(new YUKA.Vector3());
  ag.fleeB = new YUKA.FleeBehavior(new YUKA.Vector3(), 10);
  ag.pursuitB = new YUKA.PursuitBehavior(ag, 1.2);
  ag.avoidB = new YUKA.ObstacleAvoidanceBehavior(gameState.yukaObs);
  ag.avoidB.weight = 3;
  ag.steering.add(ag.wanderB); ag.steering.add(ag.arriveB);
  ag.steering.add(ag.seekB); ag.steering.add(ag.fleeB);
  ag.steering.add(ag.pursuitB); ag.steering.add(ag.avoidB);

  // Setup NavMesh proper runtime
  ag.navRuntime = new NavAgentRuntime(ag, gameState.navMeshManager);
  ag.navRuntime.initFromSpawn(ag.spawnPos);

  ag.wanderB.weight = 0;
  ag.arriveB.weight = 0; ag.seekB.weight = 0;
  ag.fleeB.weight = 0; ag.pursuitB.weight = 0;

  ag.stateMachine = new YUKA.StateMachine(ag);
  ag.stateMachine.add('PATROL', new PatrolState());
  ag.stateMachine.add('ENGAGE', new EngageState());
  ag.stateMachine.add('INVESTIGATE', new InvestigateState());
  ag.stateMachine.add('RETREAT', new RetreatState());
  ag.stateMachine.add('COVER', new CoverState());
  ag.stateMachine.add('FLANK', new FlankState());
  ag.stateMachine.add('SEEK_PICKUP', new SeekPickupState());
  ag.stateMachine.add('TEAM_PUSH', new TeamPushState());
  ag.stateMachine.add('PEEK', new PeekState());
  ag.stateMachine.changeTo('PATROL');

  ag.brain.addEvaluator(new AttackEvaluator(1.0 + personality.aggressionBias));
  ag.brain.addEvaluator(new SurviveEvaluator(1.2 + personality.cautionBias));
  ag.brain.addEvaluator(new ReloadEvaluator(1.0));
  ag.brain.addEvaluator(new SeekHealthEvaluator(1.1));
  ag.brain.addEvaluator(new GetWeaponEvaluator(1.3));
  ag.brain.addEvaluator(new HuntEvaluator(0.9 + personality.aggressionBias * 0.3));
  ag.brain.addEvaluator(new PatrolEvaluator(1.0));
  setupFuzzy(ag);
  ag.perceptionSlot = gameState.agents.length % 3;

  (ag as any)._brState = {
    phase: 'inactive',
    phaseStart: 0,
    lodTier: 3,
    lootTargetId: null,
    poiTarget: null,
    poiTargetSetAt: 0,
    hasLooted: false,
    stuckTimer: 0,
    lastX: x,
    lastZ: z,
    skeletalAttached: false,
    skeletalLastFlipAt: -10,
    combatSuppressUntil: 0,
    lastPhaseDecision: 0,
    thirdPartyPos: null,
    thirdPartyExpiresAt: 0,
    endgameHold: null,
    endgameHoldSetAt: 0,
  } as BRBotState;

  ag.active = false;
  root.visible = false;

  ag.weaponId = 'knife';
  ag.damage = 55; ag.magSize = 0; ag.ammo = 0;

  gameState.entityManager.add(ag);
  gameState.agents.push(ag);
  botGrid.insert(ag, x, z);
  return ag;
}

function generateSpawnPoints(count: number): [number, number][] {
  const map = getBRMapData();
  const spawns: [number, number][] = [];

  if (!map || map.pois.length === 0) {
    for (let i = 0; i < count; i++) {
      spawns.push([
        (Math.random() - 0.5) * BR_MAP_HALF * 1.4,
        (Math.random() - 0.5) * BR_MAP_HALF * 1.4,
      ]);
    }
    return spawns;
  }

  for (let i = 0; i < count; i++) {
    const poi = map.pois[i % map.pois.length];
    const angle = Math.random() * Math.PI * 2;
    const dist = 6 + Math.random() * Math.max(10, poi.radius);
    spawns.push([
      poi.x + Math.cos(angle) * dist,
      poi.z + Math.sin(angle) * dist,
    ]);
  }
  return spawns;
}

export async function buildBRBots(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const classes: BotClass[] = ['rifleman', 'assault', 'sniper', 'flanker'];
  const count = BR_TOTAL_PLAYERS - 1;
  const spawns = generateSpawnPoints(count);

  for (let i = 0; i < count; i++) {
    const name = BOT_NAMES[i % BOT_NAMES.length] +
      (i >= BOT_NAMES.length ? `${Math.floor(i / BOT_NAMES.length)}` : '');
    const cls = classes[i % classes.length];
    const [x, z] = spawns[i];
    mkBot(name, cls, x, z);

    if ((i + 1) % SPAWN_CHUNK_SIZE === 0 || i === count - 1) {
      onProgress?.(i + 1, count);
      await new Promise<void>(r => requestAnimationFrame(() => r()));
    }
  }
}

export function landBRBots(): void {
  const now = gameState.worldElapsed;
  for (const ag of gameState.agents) {
    if (ag === gameState.player) continue;
    const state = getBRState(ag);
    if (!state) continue;

    ag.position.y = 0;
    ag.active = true;
    if (ag.renderComponent) ag.renderComponent.visible = true;

    state.phase = 'loot_urgent';
    state.phaseStart = now;
    state.combatSuppressUntil = now +
      COMBAT_SUPPRESS_MIN_S + Math.random() * (COMBAT_SUPPRESS_MAX_S - COMBAT_SUPPRESS_MIN_S);
  }
}

export function clearBRBots(): void {
  for (let i = gameState.agents.length - 1; i >= 0; i--) {
    const ag = gameState.agents[i];
    if (ag === gameState.player) continue;
    if ((ag as any)._brState) {
      // Dispose name tag and HP bar GPU resources
      if (ag.nameTag) disposeNameTag(ag.nameTag);
      disposeHPBar(ag);
      if (ag.renderComponent) {
        ag.renderComponent.traverse(child => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh;
            m.geometry?.dispose();
            if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
            else if (m.material) (m.material as THREE.Material).dispose();
          }
        });
        gameState.scene.remove(ag.renderComponent);
      }
      gameState.entityManager.remove(ag);
      gameState.agents.splice(i, 1);
    }
  }
  botGrid.clear();
}

// ─────────────────────────────────────────────────────────────────────
//  LOD  (unchanged from original)
// ─────────────────────────────────────────────────────────────────────

function computeLOD(ag: TDMAgent): 0 | 1 | 2 | 3 {
  const dx = ag.position.x - gameState.player.position.x;
  const dz = ag.position.z - gameState.player.position.z;
  const d2 = dx * dx + dz * dz;
  if (d2 < AI_LOD_TIER1 * AI_LOD_TIER1) return 0;
  if (d2 < AI_LOD_TIER2 * AI_LOD_TIER2) return 1;
  if (d2 < AI_LOD_TIER3 * AI_LOD_TIER3) return 2;
  return 3;
}

function updateBotVisualLOD(ag: TDMAgent, state: BRBotState, now: number): void {
  if (!ag.renderComponent) return;
  if (now - state.skeletalLastFlipAt < 2) return;

  const dx = ag.position.x - gameState.player.position.x;
  const dz = ag.position.z - gameState.player.position.z;
  const d = Math.sqrt(dx * dx + dz * dz);

  const needsSkeletal = d < SKELETAL_ACTIVATION_DIST;
  const shouldDrop = d > SKELETAL_DEACTIVATION_DIST;

  if (needsSkeletal && !state.skeletalAttached) {
    const hasAssets = ag.team === TEAM_BLUE ? hasBlueSwatAssets() : hasEnemyAssets();
    if (!hasAssets) return;
    for (let i = ag.renderComponent.children.length - 1; i >= 0; i--) {
      const child = ag.renderComponent.children[i];
      if (child === ag.nameTag || child === ag.hpBarGroup) continue;
      child.traverse(c => { if ((c as THREE.Mesh).isMesh) { (c as THREE.Mesh).geometry?.dispose(); const mt = (c as THREE.Mesh).material; if (Array.isArray(mt)) mt.forEach(m => m.dispose()); else if (mt) (mt as THREE.Material).dispose(); } });
      ag.renderComponent.remove(child);
    }
    try {
      if (ag.team === TEAM_BLUE) attachBlueSwatCharacter(ag.renderComponent as THREE.Group);
      else attachEnemyCharacter(ag.renderComponent as THREE.Group);
      state.skeletalAttached = true;
      state.skeletalLastFlipAt = now;
    } catch {
      ag.renderComponent.add(buildPlaceholderMesh(ag.team, ag.botClass));
    }
  } else if (state.skeletalAttached && shouldDrop) {
    for (let i = ag.renderComponent.children.length - 1; i >= 0; i--) {
      const child = ag.renderComponent.children[i];
      if (child === ag.nameTag || child === ag.hpBarGroup) continue;
      child.traverse(c => { if ((c as THREE.Mesh).isMesh) { (c as THREE.Mesh).geometry?.dispose(); const mt = (c as THREE.Mesh).material; if (Array.isArray(mt)) mt.forEach(m => m.dispose()); else if (mt) (mt as THREE.Material).dispose(); } });
      ag.renderComponent.remove(child);
    }
    delete (ag.renderComponent.userData as any).agentAnimController;
    delete (ag.renderComponent.userData as any).characterModel;
    ag.renderComponent.add(buildPlaceholderMesh(ag.team, ag.botClass));
    state.skeletalAttached = false;
    state.skeletalLastFlipAt = now;
  }
}

export function shouldUpdateBot(ag: TDMAgent, frameCount: number): boolean {
  if (!ag.active) return false;
  const state = getBRState(ag);
  if (!state) return true;
  if (state.phase === 'inactive') return false;

  state.lodTier = computeLOD(ag);

  if (ag.currentTarget && state.lodTier <= 1) return true;

  switch (state.lodTier) {
    case 0: return true;
    case 1: return (frameCount + ag.perceptionSlot) % 3 === 0;
    case 2: return (frameCount + ag.perceptionSlot) % 6 === 0;
    case 3: return (frameCount + ag.perceptionSlot) % 15 === 0;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
//  STEERING HELPERS
// ─────────────────────────────────────────────────────────────────────

function clearSteering(ag: TDMAgent): void {
  if (ag.wanderB) ag.wanderB.weight = 0;
  if (ag.arriveB) ag.arriveB.weight = 0;
  if (ag.seekB) ag.seekB.weight = 0;
  if (ag.fleeB) ag.fleeB.weight = 0;
  if (ag.pursuitB) ag.pursuitB.weight = 0;
}

function goTo(ag: TDMAgent, x: number, z: number, weight = 1.4): void {
  clearSteering(ag);
  if (ag.arriveB) {
    (ag.arriveB as any).target.set(x, 0, z);
    ag.arriveB.weight = weight;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  LOOT (unchanged)
// ─────────────────────────────────────────────────────────────────────

function isInsideCollider(x: number, z: number): boolean {
  for (const c of gameState.arenaColliders) {
    if (c.type === 'box') {
      if (Math.abs(x - c.x) < c.hw && Math.abs(z - c.z) < c.hd) return true;
    } else {
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz < c.r * c.r) return true;
    }
  }
  return false;
}

function botWantsItem(ag: TDMAgent, item: any): boolean {
  if (item.category === 'weapon') {
    if (ag.weaponId === 'unarmed' || ag.weaponId === 'knife') return true;
    const cur = WEAPONS[ag.weaponId]?.desirability ?? 0;
    const offered = WEAPONS[item.weaponId as keyof typeof WEAPONS]?.desirability ?? 0;
    return offered > cur;
  }
  if (item.category === 'ammo') return ag.weaponId !== 'knife' && ag.ammo < ag.magSize * 2;
  if (item.category === 'heal') return ag.hp < ag.maxHP;
  if (item.category === 'grenade') return ag.grenades < 3;
  return false;
}

function botWantsAnyItem(ag: TDMAgent, items: any[]): boolean {
  for (const it of items) if (botWantsItem(ag, it)) return true;
  return false;
}

function applyItemToBot(ag: TDMAgent, item: any): void {
  if (item.category === 'weapon' && item.weaponId) {
    const wep = WEAPONS[item.weaponId as keyof typeof WEAPONS];
    if (!wep) return;
    ag.weaponId = item.weaponId;
    ag.damage = wep.damage * (1 + (item.damageBonus ?? 0));
    ag.fireRate = wep.fireRate;
    ag.burstSize = wep.burstSize;
    ag.burstDelay = wep.burstDelay;
    ag.reloadTime = wep.reloadTime;
    ag.magSize = wep.magSize;
    ag.ammo = wep.magSize;
    ag.aimError = wep.aimError * (1 - (item.spreadReduction ?? 0));
  } else if (item.category === 'ammo') {
    ag.ammo = Math.min(ag.magSize * 3, ag.ammo + (item.qty ?? 20));
  } else if (item.category === 'heal') {
    ag.hp = Math.min(ag.maxHP, ag.hp + (item.id === 'heal_b' ? 100 : 25));
  } else if (item.category === 'grenade') {
    ag.grenades = Math.min(3, ag.grenades + (item.qty ?? 1));
  }
}

function findNearestWantedLoot(ag: TDMAgent, radius: number): { id: number; x: number; z: number } | null {
  const candidates = lootGrid.queryRadius(ag.position.x, ag.position.z, radius);
  let best: { id: number; x: number; z: number; d2: number } | null = null;
  for (const c of candidates) {
    if (!c.obj.alive) continue;
    if (isInsideCollider(c.obj.x, c.obj.z)) continue;
    if (!botWantsAnyItem(ag, c.obj.items)) continue;
    if (!best || c.distSq < best.d2) {
      best = { id: c.obj.id, x: c.obj.x, z: c.obj.z, d2: c.distSq };
    }
  }
  return best ? { id: best.id, x: best.x, z: best.z } : null;
}

function findNearestPOI(ag: TDMAgent): { x: number; z: number } | null {
  const map = getBRMapData();
  if (!map) return null;
  let best: { x: number; z: number; d2: number } | null = null;
  for (const poi of map.pois) {
    if (zone.active && isOutsideZone(poi.x, poi.z)) continue;
    const dx = poi.x - ag.position.x;
    const dz = poi.z - ag.position.z;
    const d2 = dx * dx + dz * dz;
    if (!best || d2 < best.d2) best = { x: poi.x, z: poi.z, d2 };
  }
  return best ? { x: best.x, z: best.z } : null;
}

function tryPickupNearby(ag: TDMAgent, state: BRBotState): void {
  const nearby = lootGrid.queryRadius(ag.position.x, ag.position.z, 2.5);
  for (const entry of nearby) {
    const g = entry.obj;
    if (!g.alive) continue;
    const remaining: typeof g.items = [];
    for (const item of g.items) {
      if (botWantsItem(ag, item)) {
        applyItemToBot(ag, item);
        state.hasLooted = true;
      } else {
        remaining.push(item);
      }
    }
    g.items = remaining;
    if (g.items.length === 0) removeGroundLoot(g.id);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  ZONE
// ─────────────────────────────────────────────────────────────────────

function rotateToZone(ag: TDMAgent, innerFactor = 0.5): void {
  if (!zone.active) return;
  const target = zone.isShrinking ? zone.targetCenter : zone.currentCenter;
  const targetR = zone.isShrinking ? zone.targetRadius : zone.currentRadius;
  const dx = target.x - ag.position.x;
  const dz = target.y - ag.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz) || 1;
  const tx = target.x - (dx / dist) * Math.max(4, targetR * innerFactor);
  const tz = target.y - (dz / dist) * Math.max(4, targetR * innerFactor);
  goTo(ag, tx, tz, 1.5);
}

// ─────────────────────────────────────────────────────────────────────
//  PHASE DECISION — the brain
// ─────────────────────────────────────────────────────────────────────

function isEffectivelyUnarmed(ag: TDMAgent): boolean {
  return ag.weaponId === 'unarmed' || ag.weaponId === 'knife' || (ag.ammo <= 0 && !ag.isReloading);
}

function isEndgame(): boolean {
  return zone.active && zone.currentRadius > 0 && zone.currentRadius < 35;
}

function playersAliveRoughly(): number {
  let n = 0;
  for (const a of gameState.agents) if (!a.isDead) n++;
  return n;
}

function determinePhase(ag: TDMAgent, state: BRBotState, now: number): BRBotPhase {
  const hpRatio = ag.hp / ag.maxHP;
  const unarmed = isEffectivelyUnarmed(ag);
  const hasTarget = !!ag.currentTarget && !ag.currentTarget.isDead;
  const outside = isOutsideZone(ag.position.x, ag.position.z);
  const nearEdge = distanceToZoneEdge(ag.position.x, ag.position.z) < 25;
  const suppressed = now < state.combatSuppressUntil;
  const endgame = isEndgame();

  // 1) Storm — hardest constraint
  if (outside) return 'storm_flee';

  // 2) Combat decision with full context
  if (hasTarget && !unarmed && !suppressed) {
    const decision = decideEngagement(ag, ag.currentTarget!);
    if (decision.action === 'disengage') return 'retreating';
    // 'push', 'trade', 'flank' all become engagement; combat goals handle specifics
    return 'engaging';
  }

  // 3) Critically wounded under fire
  if (hpRatio < 0.3 && (now - ag.lastDamageTime) < 4) return 'retreating';

  // 4) Unarmed + enemy nearby → retreat
  if (unarmed && hasTarget) {
    const d = ag.position.distanceTo(ag.currentTarget!.position);
    if (d < 25) return 'retreating';
  }

  // 5) Unarmed → loot is the only priority
  if (unarmed) return 'loot_urgent';

  // 6) Heal when safe and wounded — a real player would pop a med here
  if (shouldHealUp(ag, state)) return 'heal_up';

  // 7) Endgame: once circle is small, seek elevation + hold
  if (endgame) return 'endgame_hold';

  // 8) Zone pressure
  if (nearEdge && zone.active && zone.isShrinking) return 'rotating';

  // 9) Third-party — look for ongoing fights nearby
  if (!suppressed && ag.hp > ag.maxHP * 0.5) {
    const fight = findNearbyFight(ag, 55);
    if (fight && fight.staleness < 0.6) {
      const p = ag.personality;
      const opportunism = p ? (0.4 + p.egoismBias + p.aggressionBias * 0.5) : 0.5;
      if (Math.random() < opportunism) {
        state.thirdPartyPos = { x: fight.pos.x, z: fight.pos.z };
        state.thirdPartyExpiresAt = now + 6;
        return 'third_party';
      }
    }
  }

  // 10) Continue active third-party if recently set
  if (state.thirdPartyPos && now < state.thirdPartyExpiresAt) {
    return 'third_party';
  }

  // 11) Still under-geared or wounded → keep looting
  if (!state.hasLooted) return 'loot_safe';
  if (hpRatio < 0.65 && Math.random() < 0.5) return 'loot_safe';
  if (ag.ammo < ag.magSize * 0.3) return 'loot_safe';

  // 12) Hunt vs. roam-loot — weighted by how many players remain
  const alive = playersAliveRoughly();
  const p = ag.personality;
  const huntChance = p ? (0.4 + p.aggressionBias * 0.5 + p.egoismBias * 0.3) : 0.45;
  // Fewer players left → hunt more aggressively
  const alivePush = alive < 12 ? 0.3 : alive < 20 ? 0.15 : 0;
  if (Math.random() < huntChance + alivePush) return 'hunting';
  return 'loot_safe';
}

// ─────────────────────────────────────────────────────────────────────
//  PHASE HANDLERS
// ─────────────────────────────────────────────────────────────────────

function handleStormFlee(ag: TDMAgent): void {
  rotateToZone(ag, 0.4);
  const base = CLASS_CONFIGS[ag.botClass].maxSpeed;
  ag.maxSpeed = base * 1.35;
}

function handleRetreating(ag: TDMAgent, state: BRBotState): void {
  const threat = ag.lastAttacker ?? ag.currentTarget;

  if (threat && !threat.isDead) {
    const cover = findCoverFrom(ag, threat.position);
    if (cover) {
      goTo(ag, cover.x, cover.z, 1.7);
      ag.currentCover = cover;
      return;
    }
    const ax = ag.position.x - threat.position.x;
    const az = ag.position.z - threat.position.z;
    const d = Math.hypot(ax, az) || 1;
    let fx = ag.position.x + (ax / d) * 18;
    let fz = ag.position.z + (az / d) * 18;
    if (isInsideCollider(fx, fz)) {
      const safe = pushOutOfWall(fx, fz);
      fx = safe.x; fz = safe.z;
    }
    goTo(ag, fx, fz, 1.8);
    return;
  }

  const b = buildingGrid.nearest(ag.position.x, ag.position.z, 60);
  if (b && b.obj.doorPositions.length > 0) {
    const door = b.obj.doorPositions[0];
    goTo(ag, door.x, door.z, 1.4);
    return;
  }
  rotateToZone(ag);
}

function handleLootUrgent(ag: TDMAgent, state: BRBotState): void {
  if (ag.currentTarget && !ag.currentTarget.isDead) {
    const d = ag.position.distanceTo(ag.currentTarget.position);
    if (d < 20) { handleRetreating(ag, state); return; }
  }
  const loot = findNearestWantedLoot(ag, 60);
  if (loot) { state.lootTargetId = loot.id; goTo(ag, loot.x, loot.z, 1.7); return; }
  const poi = findNearestPOI(ag);
  if (poi) {
    state.poiTarget = poi; state.poiTargetSetAt = gameState.worldElapsed;
    goTo(ag, poi.x + (Math.random() - 0.5) * 10, poi.z + (Math.random() - 0.5) * 10, 1.5);
    return;
  }
  clearSteering(ag);
  if (ag.wanderB) ag.wanderB.weight = 1;
}

function handleLootSafe(ag: TDMAgent, state: BRBotState): void {
  const loot = findNearestWantedLoot(ag, 40);
  if (loot) { state.lootTargetId = loot.id; goTo(ag, loot.x, loot.z, 1.3); return; }

  const now = gameState.worldElapsed;
  if (state.poiTarget && (now - state.poiTargetSetAt) > 8) state.poiTarget = null;
  if (!state.poiTarget) {
    const poi = findNearestPOI(ag);
    if (poi) { state.poiTarget = poi; state.poiTargetSetAt = now; }
  }
  if (state.poiTarget) { goTo(ag, state.poiTarget.x, state.poiTarget.z, 1.2); return; }
  clearSteering(ag);
  if (ag.wanderB) ag.wanderB.weight = 1;
}

function handleHealUp(ag: TDMAgent, state: BRBotState): void {
  // Walk into cover (if threat was recent) or stand still
  const threat = ag.lastAttacker;
  if (threat && !threat.isDead && gameState.worldElapsed - ag.lastDamageTime < 6) {
    const cover = findCoverFrom(ag, threat.position);
    if (cover) { goTo(ag, cover.x, cover.z, 1.3); }
  } else {
    // Stand still "chugging" — stop all steering
    clearSteering(ag);
  }
  // Apply heal once — the chug is instant in gameplay terms, with cooldown
  doHealUp(ag, state);
}

function handleThirdParty(ag: TDMAgent, state: BRBotState): void {
  if (!state.thirdPartyPos) { clearSteering(ag); if (ag.wanderB) ag.wanderB.weight = 1; return; }
  // Approach the fight from cover — goTo with slight weight
  goTo(ag, state.thirdPartyPos.x, state.thirdPartyPos.z, 1.45);
  // If we reach it, clear so we can re-evaluate (likely 'engaging' next tick)
  const d = Math.hypot(state.thirdPartyPos.x - ag.position.x, state.thirdPartyPos.z - ag.position.z);
  if (d < 12 || gameState.worldElapsed > state.thirdPartyExpiresAt) {
    state.thirdPartyPos = null;
  }
}

function handleRotating(ag: TDMAgent): void { rotateToZone(ag, 0.5); }

function handleHunting(ag: TDMAgent): void {
  if (ag.hasLastKnown) { goTo(ag, ag.lastKnownPos.x, ag.lastKnownPos.z, 1.3); return; }
  if (zone.active) {
    const dx = zone.currentCenter.x - ag.position.x;
    const dz = zone.currentCenter.y - ag.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > zone.currentRadius * 0.4) {
      const tx = zone.currentCenter.x - (dx / d) * zone.currentRadius * 0.4;
      const tz = zone.currentCenter.y - (dz / d) * zone.currentRadius * 0.4;
      goTo(ag, tx, tz, 1.2);
      return;
    }
    // Already near centre — patrol small arc
    const a = Math.random() * Math.PI * 2;
    const rr = Math.min(zone.currentRadius * 0.6, 25);
    goTo(ag, zone.currentCenter.x + Math.cos(a) * rr, zone.currentCenter.y + Math.sin(a) * rr, 1.1);
    return;
  }
  clearSteering(ag);
  if (ag.wanderB) ag.wanderB.weight = 1;
}

function handleEndgameHold(ag: TDMAgent, state: BRBotState): void {
  const now = gameState.worldElapsed;
  // Cache hold spot — but refresh if zone shifted
  if (!state.endgameHold || now - state.endgameHoldSetAt > 6) {
    state.endgameHold = findEndgameHold(ag);
    state.endgameHoldSetAt = now;
  }
  if (state.endgameHold) {
    const dist = ag.position.distanceTo(state.endgameHold);
    if (dist > 3) {
      goTo(ag, state.endgameHold.x, state.endgameHold.z, 1.35);
    } else {
      // Reached hold — stand still, hold angles toward centre
      clearSteering(ag);
      // Face zone centre so FOV catches pushes
      if (zone.active) {
        // Nudge heading toward centre via seek with tiny weight
        if (ag.seekB) {
          (ag.seekB as any).target.set(zone.currentCenter.x, 0, zone.currentCenter.y);
          ag.seekB.weight = 0.02;
        }
      }
    }
  } else {
    rotateToZone(ag, 0.3);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  FRAME UPDATE
// ─────────────────────────────────────────────────────────────────────

export function updateBRBot(ag: TDMAgent, dt: number): void {
  const state = getBRState(ag);
  if (!state) return;
  if (state.phase === 'inactive') return;

  const now = gameState.worldElapsed;

  botGrid.update(ag, ag.position.x, ag.position.z);
  updateBotVisualLOD(ag, state, now);

  if (ag.renderComponent) ag.renderComponent.visible = state.lodTier < 3;

  ag.maxSpeed = CLASS_CONFIGS[ag.botClass].maxSpeed;

  // Stuck detection
  const moveDx = ag.position.x - state.lastX;
  const moveDz = ag.position.z - state.lastZ;
  if (moveDx * moveDx + moveDz * moveDz < 0.04) state.stuckTimer += dt;
  else state.stuckTimer = 0;
  state.lastX = ag.position.x;
  state.lastZ = ag.position.z;

  if (state.stuckTimer > 1.2 && state.phase !== 'endgame_hold') {
    state.stuckTimer = 0;
    state.lootTargetId = null;
    state.poiTarget = null;
    state.thirdPartyPos = null;

    const nearbyB = buildingGrid.queryRadius(ag.position.x, ag.position.z, 25);
    let bestDoor: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const entry of nearbyB) {
      const b = entry.obj;
      if (Math.abs(ag.position.x - b.cx) < b.hw + 1.5 &&
          Math.abs(ag.position.z - b.cz) < b.hd + 1.5) {
        for (const door of b.doorPositions) {
          const ddx = ag.position.x - door.x;
          const ddz = ag.position.z - door.z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < bestDist) { bestDist = d2; bestDoor = door; }
        }
      }
    }

    if (bestDoor) goTo(ag, bestDoor.x, bestDoor.z, 2.0);
    else {
      const pushed = pushOutOfWall(ag.position.x, ag.position.z);
      ag.position.set(pushed.x, 0, pushed.z);
      clearSteering(ag);
      if (ag.wanderB) ag.wanderB.weight = 1.5;
    }
  }

  // Re-evaluate phase ~4x/sec
  if (now - state.lastPhaseDecision > 0.25) {
    state.lastPhaseDecision = now;
    const newPhase = determinePhase(ag, state, now);
    if (newPhase !== state.phase) {
      state.phase = newPhase;
      state.phaseStart = now;
    }
  }

  switch (state.phase) {
    case 'storm_flee':    handleStormFlee(ag); break;
    case 'retreating':    handleRetreating(ag, state); break;
    case 'loot_urgent':   handleLootUrgent(ag, state); break;
    case 'loot_safe':     handleLootSafe(ag, state); break;
    case 'heal_up':       handleHealUp(ag, state); break;
    case 'third_party':   handleThirdParty(ag, state); break;
    case 'rotating':      handleRotating(ag); break;
    case 'hunting':       handleHunting(ag); break;
    case 'endgame_hold':  handleEndgameHold(ag, state); break;
    case 'engaging':      /* updateAI owns steering */ break;
  }

  tryPickupNearby(ag, state);
}
