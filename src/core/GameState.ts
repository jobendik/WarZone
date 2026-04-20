import * as THREE from 'three';
import * as YUKA from 'yuka';
import type { TDMAgent } from '@/entities/TDMAgent';
import type { WeaponId } from '@/config/weapons';
import type { BotClass } from '@/config/classes';
import type { GameMode } from './GameModes';
import { NavMeshManager } from '@/ai/navigation/NavMeshManager';
import { AsyncPathPlanner } from '@/ai/navigation/PathPlanner';

// ────────────────────────────────────────────
//  Shared type definitions
// ────────────────────────────────────────────

export interface BoxCollider {
  type: 'box';
  x: number;
  z: number;
  hw: number;
  hd: number;
  /** If set, collider is ignored when entity Y >= yTop (steppable surfaces). */
  yTop?: number;
}

export interface CircleCollider {
  type: 'circle';
  x: number;
  z: number;
  r: number;
  yTop?: number;
}

export type Collider = BoxCollider | CircleCollider;

export interface Bullet {
  mesh: THREE.Mesh;
  pl: THREE.PointLight;
  dir: THREE.Vector3;
  ownerType: 'player' | 'ai';
  ownerTeam: number;
  ownerAgent?: TDMAgent | null;
  dmg: number;
  spd: number;
  life: number;
  isRocket?: boolean;
  isGrenade?: boolean;
  splashRadius?: number;
  grenadeType?: 'frag' | 'smoke' | 'flash';
  release?: (() => void) | null;
}

export interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  mL: number;
  isRing?: boolean;
  isSmoke?: boolean;
  light?: THREE.PointLight;
  _pool?: any;
  _sharedGeometry?: boolean;
  _sharedMaterial?: boolean;
  _lightPool?: any;
}

export interface Pickup {
  mesh: THREE.Mesh;
  ring: THREE.Mesh;
  active: boolean;
  respawnAt: number;
  t: 'health' | 'ammo' | 'weapon' | 'grenade';
  x: number;
  z: number;
  weaponId?: WeaponId;
}

export interface KillfeedEntry {
  killer: string;
  victim: string;
  killerTeam: number;
  victimTeam: number;
  time: number;
  weaponName?: string;
  weaponId?: string;
  headshot?: boolean;
  isAssist?: boolean;
  isWallbang?: boolean;
}

export interface FlagState {
  team: 0 | 1;
  base: THREE.Vector3;
  mesh: THREE.Object3D | null;
  carriedBy: TDMAgent | null;
  dropped: boolean;
  home: boolean;
  dropPos: THREE.Vector3;
}

export interface InputKeys {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  r: boolean;
  shift: boolean;
  tab: boolean;
  g: boolean;
  '1': boolean;
  '2': boolean;
  '3': boolean;
}

// ────────────────────────────────────────────
//  Global mutable game state
// ────────────────────────────────────────────

export const gameState = {
  // Three.js core
  scene: null as unknown as THREE.Scene,
  camera: null as unknown as THREE.PerspectiveCamera,
  renderer: null as unknown as THREE.WebGLRenderer,
  raycaster: null as unknown as THREE.Raycaster,
  time: null as unknown as YUKA.Time,
  entityManager: null as unknown as YUKA.EntityManager,

  // Navigation
  navMeshManager: new NavMeshManager(),
  pathPlanner: null as AsyncPathPlanner | null,

  // Viewmodel

  // World elapsed time (only advances when unpaused)
  worldElapsed: 0,

  // Match state
  mode: 'tdm' as GameMode,
  mainMenuOpen: true,
  paused: false,
  matchTime: 300,
  matchTimeRemaining: 300,
  scoreLimit: 10,

  // Elimination mode state
  eliminationRound: 0,
  eliminationBlueAlive: 0,
  eliminationRedAlive: 0,

  // Collision and world objects
  wallMeshes: [] as THREE.Mesh[],
  yukaObs: [] as YUKA.GameEntity[],
  colliders: [] as Collider[],
  arenaColliders: [] as Collider[],
  coverPoints: [] as YUKA.Vector3[],

  // Entities
  agents: [] as TDMAgent[],
  player: null as unknown as TDMAgent,

  // Projectiles (rockets/grenades only now) and effects
  bullets: [] as Bullet[],
  particles: [] as Particle[],

  // Pickups
  pickups: [] as Pickup[],

  // Objectives
  flags: {
    0: { team: 0 as 0 | 1, base: new THREE.Vector3(), mesh: null, carriedBy: null, dropped: false, home: true, dropPos: new THREE.Vector3() } as FlagState,
    1: { team: 1 as 0 | 1, base: new THREE.Vector3(), mesh: null, carriedBy: null, dropped: false, home: true, dropPos: new THREE.Vector3() } as FlagState,
  } as Record<0 | 1, FlagState>,

  // Player state
  pHP: 100,
  pAmmo: 30,
  pMaxAmmo: 30,
  pKills: 0,
  pDeaths: 0,
  pKillStreak: 0,
  pShotsFired: 0,
  pShotsHit: 0,
  pHeadshots: 0,
  pDead: false,
  pDBNO: false,
  pDBNOTimer: 0,
  deathTime: 0,
  pLastDamageTime: -10,
  lastPlayerKillTime: -10,
  respTimer: 0,
  pReloading: false,
  pReloadTimer: 0,
  pReloadDuration: 2.0,
  pAmmoReserve: 90, // ammo reserve pool

  // Player class & weapon
  pClass: 'rifleman' as BotClass,
  pWeaponId: 'assault_rifle' as WeaponId,
  pWeaponSlots: ['assault_rifle', 'pistol'] as WeaponId[],
  pActiveSlot: 0,
  pLastSlot: 0,
  pGrenades: 2,
  pSmokes: 1,
  pFlashbangs: 1,
  pGrenadeType: 'frag' as 'frag' | 'smoke' | 'flash',
  pGrenadeCooldown: 0,
  pCookingGrenade: false,
  pCookTimer: 0,
  pShootTimer: 0,
  pBurstCount: 0,
  pBurstTimer: 0,
  pFirstShotReady: true,
  pSpreadAccum: 0, // cumulative spread from sustained fire

  // Camera / input
  mouseLocked: false,
  cameraYaw: 0,
  cameraPitch: 0,
  mouseHeld: false,
  mouseDeltaX: 0,
  mouseDeltaY: 0,
  isADS: false,
  adsAmount: 0,
  keys: {
    w: false, a: false, s: false, d: false,
    r: false, shift: false, tab: false, g: false,
    '1': false, '2': false, '3': false,
  } as InputKeys,

  // Camera recoil
  recoilPitch: 0,
  recoilYaw: 0,

  // Jump state
  pPosY: 0,
  pVelY: 0,
  recoilRecoveryPitch: 0,
  recoilRecoveryYaw: 0,

  // Scores
  teamScores: [0, 0] as [number, number],
  roundOver: false,
  overtime: false,
  warmupTimer: 0,
  killfeedEntries: [] as KillfeedEntry[],

  // BR spectator
  spectatorTarget: null as TDMAgent | null,

  // Floor shader ref
  floorMat: null as THREE.ShaderMaterial | null,

  // Perception stagger — rotates which agents get full perception each frame
  perceptionFrame: 0,

  // Assists (damage contributors)
  pAssists: 0,

  // Spawn protection
  pSpawnProtectUntil: 0,

  // Bot difficulty (0..1 maps to easy..hard)
  botDifficulty: 0.5,

  // Colorblind mode
  colorblindMode: 'off' as 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia',

  // Crosshair settings
  crosshairColor: '#f0faff' as string,
  crosshairSize: 1.0,
  crosshairDot: true,

  // FPS display
  showFPS: false,

  // Subtitle display
  showSubtitles: true,

  // POTG tracking
  potgBestScore: 0,
  potgBestAgent: null as TDMAgent | null,
  potgBestTime: 0,

  // Finisher / time-scale state (MORESCRIPTS integration)
  timeScale: 1,
  _finisherLockMovement: false,
  _tutorialGrenadeThrown: false,
  _introActive: false,
  _pauseOnIntroEnd: false,
};
