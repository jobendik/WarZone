import * as THREE from 'three';
import * as YUKA from 'yuka';
import { CLASS_CONFIGS, type BotClass } from '@/config/classes';
import { TEAM_COLORS, type TeamId } from '@/config/constants';
import { CLASS_DEFAULT_WEAPON, WEAPONS, type WeaponId } from '@/config/weapons';
import type { Personality } from '@/ai/Personality';
import { createAimState, type AimState } from '@/ai/HumanAim';
import { NavAgentRuntime } from '@/ai/navigation/NavAgentRuntime';

export interface EnemyMemoryEntry {
  lastSeenPos: YUKA.Vector3;
  lastSeenTime: number;
  source: 'visual' | 'audio' | 'callout' | 'damage';
  confidence: number;
  threat: number;
  wasMoving: boolean;
  lastVelocity: YUKA.Vector3;
}

export class TDMAgent extends YUKA.Vehicle {
  declare name: string;
  team: TeamId;
  botClass: BotClass;

  hp: number;
  maxHP: number;
  isDead: boolean;
  respawnAt: number;
  spawnPos: YUKA.Vector3;
  color: number;

  damage: number;
  fireRate: number;
  burstSize: number;
  burstDelay: number;
  reloadTime: number;
  magSize: number;
  ammo: number;
  aimError: number;
  reactionTime: number;
  retreatThreshold: number;
  flankPreference: number;
  aggressivenessBase: number;

  shootTimer: number;
  burstCount: number;
  burstTimer: number;
  reloadTimer: number;
  isReloading: boolean;
  reactionTimer: number;
  hasTarget: boolean;
  decisionTimer: number;
  coverTimer: number;
  repositionTimer: number;

  stateName: string;
  currentTarget: TDMAgent | null;
  lastKnownPos: YUKA.Vector3;
  hasLastKnown: boolean;
  currentCover: YUKA.Vector3 | null;
  alertLevel: number;

  kills: number;
  deaths: number;

  wanderB: YUKA.WanderBehavior | null;
  seekB: YUKA.SeekBehavior | null;
  arriveB: YUKA.ArriveBehavior | null;
  fleeB: YUKA.FleeBehavior | null;
  pursuitB: YUKA.PursuitBehavior | null;
  avoidB: YUKA.ObstacleAvoidanceBehavior | null;

  visionRange: number;
  visionFOV: number;

  declare renderComponent: THREE.Group | null;
  nameTag: THREE.Sprite | null;
  hpBarGroup: THREE.Group | null;
  hpBarFg: THREE.Mesh | null;

  fuzzyModule: YUKA.FuzzyModule | null;
  fuzzyAggr: number;

  declare stateMachine: YUKA.StateMachine<TDMAgent>;

  brain: YUKA.Think<TDMAgent>;

  // Advanced AI
  trackingTime: number;
  strafeDir: number;
  strafeTimer: number;
  lastDamageTime: number;
  recentDamage: number;
  underPressure: boolean;
  pressureLevel: number;
  teamCallout: YUKA.Vector3 | null;
  teamCalloutTime: number;
  seekingPickup: boolean;
  seekPickupPos: YUKA.Vector3 | null;
  confidence: number;
  nearbyAllies: number;
  allyCheckTimer: number;
  stateTime: number;
  isPeeking: boolean;
  isBotCrouching: boolean;
  botLeanDir: number;
  peekTimer: number;
  lastAttacker: TDMAgent | null;
  killStreak: number;

  weaponId: WeaponId;
  secondaryWeaponId: WeaponId;
  weaponSwapCooldown: number;
  grenades: number;
  grenadeCooldown: number;
  seekingWeapon: boolean;
  huntTimer: number;

  stuckTime: number;
  lastStuckCheckPos: YUKA.Vector3;

  enemyMemory: Map<string, EnemyMemoryEntry>;
  perceptionSlot: number;
  cachedNearbyPickups: { pos: YUKA.Vector3; type: string; weaponId?: WeaponId; dist: number }[];
  pickupCacheTimer: number;

  // NavMesh proper runtime
  navRuntime!: NavAgentRuntime;

  preferredRange: number;

  // ═══════════════════════════════════════════
  //  HUMANIZATION
  // ═══════════════════════════════════════════
  personality: Personality | null;
  aim: AimState | null;
  tiltLevel: number;
  commitmentUntil: number;
  repositionUrge: number;
  grudge: TDMAgent | null;
  grudgeExpiry: number;
  preAimPos: YUKA.Vector3 | null;
  focusTime: number;

  // ── DBNO (Down But Not Out) ──
  isDBNO: boolean;
  dbnoTimer: number;
  dbnoReviver: TDMAgent | null;

  constructor(name: string, team: TeamId, botClass: BotClass) {
    super();
    this.name = name;
    this.team = team;
    this.botClass = botClass;

    const cfg = CLASS_CONFIGS[botClass] || CLASS_CONFIGS.rifleman;
    this.maxSpeed = cfg.maxSpeed;
    this.maxForce = 12;
    this.mass = 1;
    // Kept small so bots can squeeze through the narrow doorways in
    // tdm_map.glb — YUKA's neighbor/steering code uses this as the
    // inflation radius, and 0.65 was too wide to clear 1-metre openings.
    this.boundingRadius = 0.45;
    this.smoother = new YUKA.Smoother(10);
    this.updateNeighborhood = true;
    this.neighborhoodRadius = 5;

    this.hp = cfg.hp;
    this.maxHP = cfg.hp;
    this.isDead = false;
    this.respawnAt = 0;
    this.spawnPos = new YUKA.Vector3();
    this.color = TEAM_COLORS[team];

    this.aimError = cfg.aimError;
    this.reactionTime = cfg.reactionTime;
    this.retreatThreshold = cfg.retreatThreshold;
    this.flankPreference = cfg.flankPreference;
    this.aggressivenessBase = cfg.aggressiveness;

    this.shootTimer = 0;
    this.burstCount = 0;
    this.burstTimer = 0;
    this.reloadTimer = 0;
    this.isReloading = false;
    this.reactionTimer = 0;
    this.hasTarget = false;
    this.decisionTimer = 0;
    this.coverTimer = 0;
    this.repositionTimer = 0;

    this.stateName = 'SPAWN';
    this.currentTarget = null;
    this.lastKnownPos = new YUKA.Vector3();
    this.hasLastKnown = false;
    this.currentCover = null;
    this.alertLevel = 0;

    this.kills = 0;
    this.deaths = 0;

    this.wanderB = null;
    this.seekB = null;
    this.arriveB = null;
    this.fleeB = null;
    this.pursuitB = null;
    this.avoidB = null;

    this.visionRange = cfg.visionRange;
    this.visionFOV = cfg.visionFOV;

    this.nameTag = null;
    this.hpBarGroup = null;
    this.hpBarFg = null;

    this.fuzzyModule = null;
    this.fuzzyAggr = 50;

    this.brain = new YUKA.Think(this);

    this.trackingTime = 0;
    this.strafeDir = Math.random() > 0.5 ? 1 : -1;
    this.strafeTimer = 0.3 + Math.random() * 0.5;
    this.lastDamageTime = -10;
    this.recentDamage = 0;
    this.underPressure = false;
    this.pressureLevel = 0;
    this.teamCallout = null;
    this.teamCalloutTime = -10;
    this.seekingPickup = false;
    this.seekPickupPos = null;
    this.confidence = 50;
    this.nearbyAllies = 0;
    this.allyCheckTimer = 0;
    this.stateTime = 0;
    this.isPeeking = false;
    this.isBotCrouching = false;
    this.botLeanDir = 0;
    this.peekTimer = 0;
    this.lastAttacker = null;
    this.killStreak = 0;

    this.weaponId = CLASS_DEFAULT_WEAPON[botClass] || 'assault_rifle';
    this.secondaryWeaponId = 'pistol';
    this.weaponSwapCooldown = 0;
    const wepDef = WEAPONS[this.weaponId];
    this.damage = wepDef.damage;
    this.fireRate = wepDef.fireRate;
    this.burstSize = wepDef.burstSize;
    this.burstDelay = wepDef.burstDelay;
    this.reloadTime = wepDef.reloadTime;
    this.magSize = wepDef.magSize;
    this.ammo = wepDef.magSize;
    this.aimError = wepDef.aimError;
    this.grenades = 2;
    this.grenadeCooldown = 0;
    this.seekingWeapon = false;
    this.huntTimer = Math.random() * 2;

    this.stuckTime = 0;
    this.lastStuckCheckPos = new YUKA.Vector3();

    this.enemyMemory = new Map();
    this.perceptionSlot = 0;
    this.cachedNearbyPickups = [];
    this.pickupCacheTimer = 0;


    switch (botClass) {
      case 'sniper':   this.preferredRange = 35; break;
      case 'assault':  this.preferredRange = 10; break;
      case 'flanker':  this.preferredRange = 8; break;
      default:         this.preferredRange = 18; break;
    }

    // Humanization — set later by factory (personality stays null-safe here)
    this.personality = null;
    this.aim = createAimState();
    this.tiltLevel = 0;
    this.commitmentUntil = 0;
    this.repositionUrge = 0;
    this.grudge = null;
    this.grudgeExpiry = 0;
    this.preAimPos = null;
    this.focusTime = 0;

    // DBNO
    this.isDBNO = false;
    this.dbnoTimer = 0;
    this.dbnoReviver = null;
  }

  /**
   * Full tactical reset on respawn. Clears ALL stale combat/goal/memory state.
   * Personality persists; tilt and grudge persist briefly across deaths.
   */
  resetTacticalState(): void {
    this.brain.clearSubgoals();
    this.stateName = 'PATROL';
    this.stateTime = 0;
    this.hasLastKnown = false;
    this.alertLevel = 0;
    this.currentTarget = null;
    this.hasTarget = false;
    this.burstCount = 0;
    this.shootTimer = 0;
    this.reactionTimer = 0;
    this.trackingTime = 0;
    this.recentDamage = 0;
    this.underPressure = false;
    this.pressureLevel = 0;
    this.lastAttacker = null;
    this.seekingPickup = false;
    this.seekPickupPos = null;
    this.isPeeking = false;
    this.teamCallout = null;
    this.currentCover = null;
    this.huntTimer = Math.random() * 2;
    this.stuckTime = 0;
    this.lastStuckCheckPos.copy(this.position);
    this.decisionTimer = 0;
    this.fuzzyAggr = 50;
    this.confidence = 50;
    this.enemyMemory.clear();
    this.cachedNearbyPickups = [];
    this.pickupCacheTimer = 0;
    this.weaponSwapCooldown = 0;

    if (this.navRuntime) {
      this.navRuntime.clearPath();
    }

    this.aim = createAimState();
    this.commitmentUntil = 0;
    this.repositionUrge = 0;
    this.preAimPos = null;
    this.focusTime = 0;
    // tiltLevel and grudge preserved across deaths
  }
}
