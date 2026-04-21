import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { gameState } from '@/core/GameState';
import { WEAPONS, type WeaponId } from '@/config/weapons';
import { spawnShellCasing } from '@/combat/Particles';

let vmScene: THREE.Scene;
let vmCamera: THREE.PerspectiveCamera;
let vmGroup: THREE.Group;
let vmMuzzleFlash: THREE.PointLight;
let vmMuzzleMesh: THREE.Mesh;
let vmMuzzleSprite: THREE.Sprite;
// Secondary muzzle flash for dual-barrel weapons (e.g. dual MAC-10).
// Always present but only made visible when the active weapon has a
// `muzzleOffsetSecondary` defined.
let vmMuzzleFlash2: THREE.PointLight;
let vmMuzzleMesh2: THREE.Mesh;
let vmMuzzleSprite2: THREE.Sprite;

let currentWeaponMesh: THREE.Group | null = null;
let currentWeaponId: WeaponId = 'assault_rifle';
let vmHidden = false;

let currentViewmodelMixer: THREE.AnimationMixer | null = null;
let currentViewmodelActions: THREE.AnimationAction[] = [];
let currentAnimatedAction: THREE.AnimationAction | null = null;
let activeAnimatedRange: AnimatedRangeName | null = null;
let currentAnimatedWeaponId: AnimatedWeaponId | null = null;
let wasReloading = false;

let currentM16Wrapper: THREE.Group | null = null;
let m16DebugOverlay: HTMLDivElement | null = null;

let currentSMGWrapper: THREE.Group | null = null;
let smgDebugOverlay: HTMLDivElement | null = null;

interface VMLayout {
  pos: [number, number, number];
  rot: [number, number, number];
  scale: number;
  muzzleOffset: [number, number, number];
  /** Optional second muzzle offset for dual-barrel weapons (e.g. dual MAC-10). */
  muzzleOffsetSecondary?: [number, number, number];
  recoilZ: number;
  recoilUp: number;
  recoilRot: number;
  /** Per-shot vertical climb multiplier during sustained fire (0 = no climb) */
  climbPerShot: number;
  /** Bob intensity multiplier — heavier weapons bob more (default 1.0) */
  bobMul: number;
}

const VM_LAYOUTS: Record<WeaponId, VMLayout> = {
  unarmed:         { pos: [0.14, -0.25, -0.15], rot: [0, 0, 0], scale: 1.0, muzzleOffset: [0, 0, 0], recoilZ: 0, recoilUp: 0, recoilRot: 0, climbPerShot: 0, bobMul: 0.6 },
  knife:           { pos: [0.14, -0.12, -0.18], rot: [0, 0, 0], scale: 1.0, muzzleOffset: [0, 0, 0], recoilZ: 0, recoilUp: 0, recoilRot: 0, climbPerShot: 0, bobMul: 0.5 },
  pistol:          { pos: [0.14, -0.12, -0.20], rot: [0, 0, 0], scale: 1.4, muzzleOffset: [0, 0.008, -0.10], recoilZ: 0.025, recoilUp: 0.012, recoilRot: 0.08, climbPerShot: 0.008, bobMul: 0.7 },
  // Dual MAC-10: two barrels — left and right of the center axis. Both muzzles
  // flash simultaneously every shot. Tune these offsets to match the GLB.
  smg:             { pos: [0.05, -0.055, -0.130], rot: [0, 0, 0], scale: 1.0, muzzleOffset: [-0.060, 0.010, -0.170], muzzleOffsetSecondary: [0.060, 0.010, -0.170], recoilZ: 0.014, recoilUp: 0.007, recoilRot: 0.05, climbPerShot: 0.003, bobMul: 0.85 },
  assault_rifle:   { pos: [0.11, -0.10, -0.24], rot: [0, 0, 0], scale: 1.2, muzzleOffset: [0, 0.010, -0.18], recoilZ: 0.018, recoilUp: 0.008, recoilRot: 0.06, climbPerShot: 0.005, bobMul: 1.0 },
  shotgun:         { pos: [0.12, -0.11, -0.22], rot: [0, 0, 0], scale: 1.2, muzzleOffset: [0, 0.012, -0.20], recoilZ: 0.040, recoilUp: 0.025, recoilRot: 0.14, climbPerShot: 0, bobMul: 1.15 },
  sniper_rifle:    { pos: [0.10, -0.10, -0.26], rot: [0, 0, 0], scale: 1.1, muzzleOffset: [0, 0.010, -0.26], recoilZ: 0.035, recoilUp: 0.018, recoilRot: 0.10, climbPerShot: 0, bobMul: 1.3 },
  rocket_launcher: { pos: [0.14, -0.13, -0.20], rot: [0, 0, 0], scale: 1.2, muzzleOffset: [0, 0.000, -0.18], recoilZ: 0.050, recoilUp: 0.030, recoilRot: 0.12, climbPerShot: 0, bobMul: 1.4 },
};

const ADS_LAYOUTS: Partial<Record<WeaponId, VMLayout>> = {
  // Empty for now — ADS just centers each weapon. Customize per weapon if needed.
};

let recoilZ = 0;
let recoilUp = 0;
let recoilRot = 0;
let swayX = 0;
let swayY = 0;
let bobPhase = 0;
let sprintLerp = 0;
let switchProgress = 1;
/** Consecutive shot counter for recoil climb */
let climbShots = 0;
let climbResetTimer = 0;
let switchDir: 'down' | 'up' = 'up';
let pendingWeaponId: WeaponId | null = null;
let reloadLerp = 0;
let boltLockLerp = 0;

// ── Weapon inspect idle animation ──
let lastActivityTime = 0;
let inspectPhase = 0; // 0 = inactive, >0 = animating (0..1 in, 1..3 hold, 3..4 out)
const INSPECT_DELAY = 5; // seconds of inactivity before inspect starts

const BASE_URL = import.meta.env.BASE_URL;
const M16_GLB_URL = `${BASE_URL}models/weapons/m16a2.glb`;
const PISTOL_GLB_URL = `${BASE_URL}models/weapons/pistol.glb`;
const SHOTGUN_GLB_URL = `${BASE_URL}models/weapons/shotgun.glb`;
const SNIPER_GLB_URL = `${BASE_URL}models/weapons/sniper_rifle.glb`;
const GRENADE_LAUNCHER_GLB_URL = `${BASE_URL}models/weapons/grenadelauncher.glb`;
const KNIFE_GLB_URL = `${BASE_URL}models/weapons/knife.glb`;
const DUAL_MAC10_GLB_URL = `${BASE_URL}models/weapons/dual_mac10_smg.glb`;

type CachedGLB = {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
};

type AnimatedWeaponId = 'assault_rifle' | 'pistol' | 'shotgun' | 'sniper_rifle' | 'rocket_launcher' | 'smg';
type AnimatedRangeName = 'equip' | 'shoot' | 'reload' | 'hit';
type KnifeRangeName = 'equip' | 'idle' | 'slice1' | 'slice2' | 'slice3';

interface AnimatedWeaponViewmodelConfig {
  url: string;
  desiredMaxDimension: number;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  holdTime: number;
  ranges: Partial<Record<AnimatedRangeName, [number, number]>>;
  logLabel: string;
}

const ANIMATED_VIEWMODEL_CONFIGS: Record<AnimatedWeaponId, AnimatedWeaponViewmodelConfig> = {
  assault_rifle: {
    url: M16_GLB_URL,
    desiredMaxDimension: 0.930,
    position: new THREE.Vector3(0.070, -0.055, -0.180),
    rotation: new THREE.Euler(0.020, -0.220, 0.100),
    holdTime: 0.05,
    ranges: {
      shoot: [0.00, 0.20],
      reload: [2.30, 4.48],
      equip: [4.80, 6.00],
      hit: [6.80, 7.40],
    },
    logLabel: 'm16a2.glb',
  },
pistol: {
  url: PISTOL_GLB_URL,
  desiredMaxDimension: 0.70,
  position: new THREE.Vector3(0.040, -0.040, -0.110),
  rotation: new THREE.Euler(0.010, -0.120, 0.080),
  holdTime: 7.78,
  ranges: {
    shoot: [0.00, 0.30],
    reload: [0.30, 2.75],
    equip: [6.22, 7.70],
  },
  logLabel: 'pistol.glb',
},
  shotgun: {
    url: SHOTGUN_GLB_URL,
    desiredMaxDimension: 1.02,
    position: new THREE.Vector3(0.055, -0.050, -0.135),
    rotation: new THREE.Euler(0.010, -0.120, 0.060),
    holdTime: 3.32,
    ranges: {
      shoot: [0.00, 0.40],
      reload: [0.40, 2.40],
      equip: [2.70, 3.40],
    },
    logLabel: 'shotgun.glb',
  },
  sniper_rifle: {
    url: SNIPER_GLB_URL,
    desiredMaxDimension: 1.10,
    position: new THREE.Vector3(0.060, -0.045, -0.150),
    rotation: new THREE.Euler(0.010, -0.100, 0.050),
    holdTime: 4.72,
    ranges: {
      shoot: [0.00, 0.40],
      reload: [0.40, 3.85],
      equip: [4.23, 4.75],
    },
    logLabel: 'sniper_rifle.glb',
  },
  rocket_launcher: {
    url: GRENADE_LAUNCHER_GLB_URL,
    desiredMaxDimension: 1.18,
    // Pulled in closer to the camera (z: -0.155 → -0.085) so the
    // end of the left arm (edge of the rigged model) is no longer
    // visible in-frame.
    position: new THREE.Vector3(0.05, -0.055, -0.085),
    // The grenade-launcher GLB authors the model pointing toward +Z,
    // opposite to every other weapon in the set — flip it 180° around
    // Y so the muzzle faces away from the camera.
    rotation: new THREE.Euler(0.015, Math.PI - 0.145, 0.055),
    holdTime: 8.84,
    ranges: {
      shoot: [0.00, 0.37],
      reload: [0.38, 7.11],
      equip: [7.60, 8.90],
    },
    logLabel: 'grenadelauncher.glb',
  },
  smg: {
    url: DUAL_MAC10_GLB_URL,
    desiredMaxDimension: 0.870,
    position: new THREE.Vector3(0.125, -0.280, -0.185),
    rotation: new THREE.Euler(0.010, -0.660, -0.140),
    // Ranges derived from dual_mac10_smg.txt:
    //   shooting 0.00-0.25, reload 0.25-1.73, equip 2.20-2.47
    holdTime: 2.47,
    ranges: {
      shoot: [0.00, 0.25],
      reload: [0.25, 1.73],
      equip: [2.20, 2.47],
    },
    logLabel: 'dual_mac10_smg.glb',
  },
};

const SMG_VIEWMODEL_TUNE = ANIMATED_VIEWMODEL_CONFIGS.smg;

const SMG_DEBUG_TUNER = {
  enabled: false, // set true to enable tuning overlay
  position: new THREE.Vector3(
    SMG_VIEWMODEL_TUNE.position.x,
    SMG_VIEWMODEL_TUNE.position.y,
    SMG_VIEWMODEL_TUNE.position.z,
  ),
  rotation: new THREE.Euler(
    SMG_VIEWMODEL_TUNE.rotation.x,
    SMG_VIEWMODEL_TUNE.rotation.y,
    SMG_VIEWMODEL_TUNE.rotation.z,
  ),
  desiredMaxDimension: SMG_VIEWMODEL_TUNE.desiredMaxDimension,
};

const M16_VIEWMODEL_TUNE = ANIMATED_VIEWMODEL_CONFIGS.assault_rifle;

const M16_DEBUG_TUNER = {
  enabled: false, // set true to enable tuning overlay
  position: new THREE.Vector3(
    M16_VIEWMODEL_TUNE.position.x,
    M16_VIEWMODEL_TUNE.position.y,
    M16_VIEWMODEL_TUNE.position.z,
  ),
  rotation: new THREE.Euler(
    M16_VIEWMODEL_TUNE.rotation.x,
    M16_VIEWMODEL_TUNE.rotation.y,
    M16_VIEWMODEL_TUNE.rotation.z,
  ),
  desiredMaxDimension: M16_VIEWMODEL_TUNE.desiredMaxDimension,
};

const KNIFE_VIEWMODEL_TUNE = {
  desiredMaxDimension: 0.930,
  position: new THREE.Vector3(0.065, -0.160, -0.180),
  rotation: new THREE.Euler(0.020, 2.922, 0.100),
  idleTime: 0.00,
};

const KNIFE_DEBUG_TUNER = {
  enabled: false, // set true to enable tuning overlay
  position: new THREE.Vector3(
    KNIFE_VIEWMODEL_TUNE.position.x,
    KNIFE_VIEWMODEL_TUNE.position.y,
    KNIFE_VIEWMODEL_TUNE.position.z,
  ),
  rotation: new THREE.Euler(
    KNIFE_VIEWMODEL_TUNE.rotation.x,
    KNIFE_VIEWMODEL_TUNE.rotation.y,
    KNIFE_VIEWMODEL_TUNE.rotation.z,
  ),
  desiredMaxDimension: KNIFE_VIEWMODEL_TUNE.desiredMaxDimension,
};

const KNIFE_RANGES: Record<KnifeRangeName, [number, number]> = {
  equip:  [4.40, 4.83],
  idle:   [0.00, 1.35],
  slice1: [1.36, 2.00],
  slice2: [2.68, 3.40],
  slice3: [3.40, 4.15],
};

const gltfLoader = new GLTFLoader();

const cachedAnimated = new Map<AnimatedWeaponId, CachedGLB | null>();
const cachedAnimatedPromises = new Map<AnimatedWeaponId, Promise<CachedGLB | null>>();
const loggedAnimatedClips = new Set<AnimatedWeaponId>();

let cachedKnife: CachedGLB | null = null;
let cachedKnifePromise: Promise<CachedGLB | null> | null = null;
let loggedKnifeClips = false;

let currentKnifeWrapper: THREE.Group | null = null;
let currentKnifeAction: THREE.AnimationAction | null = null;
let activeKnifeRange: KnifeRangeName | null = null;
let knifeDebugOverlay: HTMLDivElement | null = null;
const proceduralWeaponTemplates = new Map<WeaponId, THREE.Group>();
const ALL_VIEWMODEL_WEAPON_IDS: WeaponId[] = [
  'unarmed',
  'knife',
  'pistol',
  'smg',
  'assault_rifle',
  'shotgun',
  'sniper_rifle',
  'rocket_launcher',
];

function prepRenderable(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as any).isMesh) {
      // PERF: view-model never needs to cast or receive shadows (it lives
      // on a camera-overlay layer and the sun never projects through it).
      // Enabling them previously forced an extra shadow-map rasterisation
      // per-frame of the full weapon, which on a 9MB GLB is a real cost.
      // Also leave `transparent` unset — forcing it on every material
      // disables the opaque fast path and breaks early-Z for the viewmodel.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
    }
  });
}

function isAnimatedWeapon(weaponId: WeaponId): weaponId is AnimatedWeaponId {
  return weaponId === 'assault_rifle'
    || weaponId === 'pistol'
    || weaponId === 'shotgun'
    || weaponId === 'sniper_rifle'
    || weaponId === 'rocket_launcher'
    || weaponId === 'smg'
}

async function loadAnimatedViewmodel(weaponId: AnimatedWeaponId): Promise<CachedGLB | null> {
  if (cachedAnimated.has(weaponId)) return cachedAnimated.get(weaponId) ?? null;

  const cachedPromise = cachedAnimatedPromises.get(weaponId);
  if (cachedPromise) return cachedPromise;

  const cfg = ANIMATED_VIEWMODEL_CONFIGS[weaponId];

  const promise = new Promise<CachedGLB | null>((resolve) => {
    gltfLoader.load(
      cfg.url,
      (gltf) => {
        const scene = gltf.scene as THREE.Group;
        prepRenderable(scene);

        const loaded = {
          scene,
          animations: gltf.animations ?? [],
        };

        cachedAnimated.set(weaponId, loaded);

        if (!loggedAnimatedClips.has(weaponId)) {
          loggedAnimatedClips.add(weaponId);
          console.info(`[WeaponViewmodel] Loaded ${cfg.logLabel}`);
          console.info(
            `[WeaponViewmodel] ${weaponId} animation clips:`,
            loaded.animations.map((clip) => ({
              name: clip.name,
              duration: clip.duration,
              tracks: clip.tracks.length,
            })),
          );
        }

        resolve(loaded);
      },
      undefined,
      (err) => {
        console.error(`[WeaponViewmodel] Failed to load ${cfg.logLabel}. Falling back to procedural weapon.`, err);
        cachedAnimated.set(weaponId, null);
        resolve(null);
      },
    );
  });

  cachedAnimatedPromises.set(weaponId, promise);
  return promise;
}

async function loadKnifeViewmodel(): Promise<CachedGLB | null> {
  if (cachedKnife) return cachedKnife;
  if (cachedKnifePromise) return cachedKnifePromise;

  cachedKnifePromise = new Promise((resolve) => {
    gltfLoader.load(
      KNIFE_GLB_URL,
      (gltf) => {
        const scene = gltf.scene as THREE.Group;
        prepRenderable(scene);

        cachedKnife = {
          scene,
          animations: gltf.animations ?? [],
        };

        if (!loggedKnifeClips) {
          loggedKnifeClips = true;
          console.info('[WeaponViewmodel] Loaded knife.glb');
          console.info(
            '[WeaponViewmodel] Knife animation clips:',
            cachedKnife.animations.map((clip) => ({
              name: clip.name,
              duration: clip.duration,
              tracks: clip.tracks.length,
            })),
          );
        }

        resolve(cachedKnife);
      },
      undefined,
      (err) => {
        console.error('[WeaponViewmodel] Failed to load knife GLB.', err);
        resolve(null);
      },
    );
  });

  return cachedKnifePromise;
}

function makeMats(wep: { color: number }) {
  const bodyMat = new THREE.MeshStandardMaterial({ color: wep.color, roughness: 0.35, metalness: 0.65 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8, metalness: 0.3 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    roughness: 0.15,
    metalness: 0.9,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.35,
  });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0.1 });
  return { bodyMat, darkMat, accentMat, gripMat };
}

function buildWeaponMesh(weaponId: WeaponId): THREE.Group {
  const wep = WEAPONS[weaponId];
  const g = new THREE.Group();

  if (weaponId === 'unarmed') {
    const skinMat = new THREE.MeshStandardMaterial({ color: 0x8d6e5a, roughness: 0.7, metalness: 0.1 });
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.035, 0.05), skinMat);
    fist.position.set(0, -0.01, 0);
    g.add(fist);

    const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.015, 0.03), skinMat);
    fingers.position.set(0, -0.025, -0.015);
    g.add(fingers);

    return g;
  }

  const { bodyMat, darkMat, accentMat, gripMat } = makeMats(wep);

  switch (weaponId) {
    case 'pistol': {
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.035, 0.095), bodyMat);
      slide.position.set(0, 0.005, 0);
      g.add(slide);

      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.025, 0.065), darkMat);
      frame.position.set(0, -0.015, 0.01);
      g.add(frame);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.058, 0.028), gripMat);
      grip.position.set(0, -0.045, 0.018);
      grip.rotation.x = 0.2;
      g.add(grip);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.04, 8), darkMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.008, -0.065);
      g.add(barrel);

      const tg = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.005, 0.025), darkMat);
      tg.position.set(0, -0.025, 0.005);
      g.add(tg);

      const fs = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.010, 0.006), accentMat);
      fs.position.set(0, 0.028, -0.038);
      g.add(fs);
      break;
    }

    case 'smg': {
      const recv = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.042, 0.14), bodyMat);
      g.add(recv);

      const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.030, 0.06), darkMat);
      shroud.position.set(0, 0, -0.095);
      g.add(shroud);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.055, 8), darkMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.005, -0.120);
      g.add(barrel);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.065, 0.022), gripMat);
      mag.position.set(0, -0.045, 0.015);
      mag.rotation.x = 0.05;
      g.add(mag);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.045, 0.020), gripMat);
      grip.position.set(0, -0.035, 0.06);
      grip.rotation.x = 0.15;
      g.add(grip);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.028, 0.055), bodyMat);
      stock.position.set(0, -0.008, 0.095);
      g.add(stock);

      const al = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.004, 0.14), accentMat);
      al.position.set(0, 0.024, 0);
      g.add(al);
      break;
    }

    case 'assault_rifle': {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.050, 0.22), bodyMat);
      g.add(body);

      const hg = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.038, 0.08), darkMat);
      hg.position.set(0, -0.004, -0.12);
      g.add(hg);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.09, 8), darkMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.008, -0.155);
      g.add(barrel);

      const mb = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.010, 0.02, 8), bodyMat);
      mb.rotation.x = Math.PI / 2;
      mb.position.set(0, 0.008, -0.195);
      g.add(mb);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.072, 0.028), gripMat);
      mag.position.set(0, -0.050, 0.015);
      mag.rotation.x = 0.12;
      g.add(mag);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.042, 0.018), gripMat);
      grip.position.set(0, -0.040, 0.065);
      grip.rotation.x = 0.2;
      g.add(grip);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.042, 0.085), bodyMat);
      stock.position.set(0, -0.006, 0.145);
      g.add(stock);

      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.048, 0.008), gripMat);
      sp.position.set(0, -0.006, 0.190);
      g.add(sp);

      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.008, 0.10), darkMat);
      rail.position.set(0, 0.032, -0.02);
      g.add(rail);

      const rds = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.018, 0.025), accentMat);
      rds.position.set(0, 0.045, -0.02);
      g.add(rds);

      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.004, 0.22), accentMat);
      stripe.position.set(0, 0.028, 0);
      g.add(stripe);
      break;
    }

    case 'shotgun': {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.050, 0.20), bodyMat);
      g.add(body);

      const b1 = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 8), darkMat);
      b1.rotation.x = Math.PI / 2;
      b1.position.set(0.008, 0.012, -0.165);
      g.add(b1);

      const b2 = b1.clone();
      b2.position.x = -0.008;
      g.add(b2);

      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.028, 0.065), bodyMat);
      pump.position.set(0, -0.022, -0.06);
      g.add(pump);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.050, 0.022), gripMat);
      grip.position.set(0, -0.040, 0.055);
      grip.rotation.x = 0.2;
      g.add(grip);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.048, 0.10), bodyMat);
      stock.position.set(0, -0.010, 0.145);
      g.add(stock);

      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 6), accentMat);
      bead.position.set(0, 0.032, -0.22);
      g.add(bead);
      break;
    }

    case 'sniper_rifle': {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.048, 0.30), bodyMat);
      g.add(body);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.18, 8), darkMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.008, -0.235);
      g.add(barrel);

      const sup = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.010, 0.04, 8), darkMat);
      sup.rotation.x = Math.PI / 2;
      sup.position.set(0, 0.008, -0.32);
      g.add(sup);

      const scopeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.10, 10), accentMat);
      scopeBody.rotation.x = Math.PI / 2;
      scopeBody.position.set(0, 0.048, -0.02);
      g.add(scopeBody);

      for (const zz of [-0.05, 0.03]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.003, 6, 12), darkMat);
        ring.position.set(0, 0.048, zz);
        g.add(ring);
      }

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.055, 0.028), gripMat);
      mag.position.set(0, -0.042, 0.04);
      g.add(mag);

      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.035, 0.008), darkMat);
        leg.position.set(side * 0.020, -0.035, -0.12);
        leg.rotation.x = 0.3;
        g.add(leg);
      }

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.052, 0.10), bodyMat);
      stock.position.set(0, -0.005, 0.195);
      g.add(stock);

      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.012, 0.06), gripMat);
      cheek.position.set(0, 0.024, 0.16);
      g.add(cheek);
      break;
    }

    case 'rocket_launcher': {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.32, 10), bodyMat);
      tube.rotation.x = Math.PI / 2;
      g.add(tube);

      const front = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.030, 10), darkMat);
      front.position.set(0, 0, -0.161);
      g.add(front);

      const rear = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.038, 0.04, 10), darkMat);
      rear.rotation.x = Math.PI / 2;
      rear.position.set(0, 0, 0.175);
      g.add(rear);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.060, 0.026), gripMat);
      grip.position.set(0, -0.045, 0.05);
      grip.rotation.x = 0.15;
      g.add(grip);

      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.025, 0.040), accentMat);
      sight.position.set(0, 0.042, -0.03);
      g.add(sight);

      const ws = new THREE.Mesh(
        new THREE.BoxGeometry(0.030, 0.005, 0.06),
        new THREE.MeshStandardMaterial({
          color: 0xffaa00,
          roughness: 0.5,
          metalness: 0.3,
          emissive: 0xffaa00,
          emissiveIntensity: 0.2,
        }),
      );
      ws.position.set(0, 0.030, 0.10);
      g.add(ws);
      break;
    }
  }

  return g;
}

function getProceduralWeaponTemplate(weaponId: WeaponId): THREE.Group {
  let template = proceduralWeaponTemplates.get(weaponId);
  if (!template) {
    template = buildWeaponMesh(weaponId);
    proceduralWeaponTemplates.set(weaponId, template);
  }
  return template;
}

function cloneProceduralWeapon(weaponId: WeaponId): THREE.Group {
  return getProceduralWeaponTemplate(weaponId).clone(true) as THREE.Group;
}

function normalizeViewmodelWrapper(
  cloneRoot: THREE.Group,
  desiredMaxDimension: number,
  position: THREE.Vector3,
  rotation: THREE.Euler,
): THREE.Group {
  const wrapper = new THREE.Group();
  const rawBox = new THREE.Box3().setFromObject(cloneRoot);
  const rawSize = new THREE.Vector3();
  const rawCenter = new THREE.Vector3();
  rawBox.getSize(rawSize);
  rawBox.getCenter(rawCenter);

  cloneRoot.position.sub(rawCenter);
  wrapper.add(cloneRoot);

  const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z);
  const scale = desiredMaxDimension / Math.max(maxDim, 0.0001);
  wrapper.scale.setScalar(scale);
  wrapper.position.copy(position);
  wrapper.rotation.copy(rotation);
  wrapper.visible = true;
  return wrapper;
}

function createAnimatedWarmupClone(weaponId: AnimatedWeaponId): THREE.Group | null {
  const cached = cachedAnimated.get(weaponId);
  if (!cached) return null;
  const cfg = ANIMATED_VIEWMODEL_CONFIGS[weaponId];
  const cloneRoot = skeletonClone(cached.scene) as THREE.Group;
  prepRenderable(cloneRoot);
  return normalizeViewmodelWrapper(cloneRoot, cfg.desiredMaxDimension, cfg.position, cfg.rotation);
}

function createKnifeWarmupClone(): THREE.Group | null {
  if (!cachedKnife) return null;
  const cloneRoot = skeletonClone(cachedKnife.scene) as THREE.Group;
  prepRenderable(cloneRoot);
  return normalizeViewmodelWrapper(cloneRoot, KNIFE_VIEWMODEL_TUNE.desiredMaxDimension, KNIFE_VIEWMODEL_TUNE.position, KNIFE_VIEWMODEL_TUNE.rotation);
}

function createViewmodelWarmupVariant(weaponId: WeaponId): THREE.Group | null {
  if (weaponId === 'knife') return createKnifeWarmupClone();
  if (isAnimatedWeapon(weaponId)) return createAnimatedWarmupClone(weaponId) ?? cloneProceduralWeapon(weaponId);

  const variant = cloneProceduralWeapon(weaponId);
  const layout = VM_LAYOUTS[weaponId];
  variant.position.set(layout.pos[0], layout.pos[1], layout.pos[2]);
  variant.rotation.set(layout.rot[0], layout.rot[1], layout.rot[2]);
  variant.scale.setScalar(layout.scale);
  return variant;
}

function ensureM16DebugOverlay(): void {
  if (!M16_DEBUG_TUNER.enabled) return;
  if (m16DebugOverlay) return;

  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.left = '12px';
  el.style.bottom = '12px';
  el.style.zIndex = '99999';
  el.style.padding = '10px 12px';
  el.style.background = 'rgba(0,0,0,0.75)';
  el.style.color = '#9fe8ff';
  el.style.fontFamily = 'monospace';
  el.style.fontSize = '12px';
  el.style.lineHeight = '1.45';
  el.style.border = '1px solid rgba(100,200,255,0.45)';
  el.style.borderRadius = '8px';
  el.style.whiteSpace = 'pre';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);

  m16DebugOverlay = el;
  refreshM16DebugOverlay();
}

function refreshM16DebugOverlay(): void {
  if (!m16DebugOverlay || !M16_DEBUG_TUNER.enabled) return;

  const p = M16_DEBUG_TUNER.position;
  const r = M16_DEBUG_TUNER.rotation;

  m16DebugOverlay.textContent =
`M16 VIEWMODEL TUNER

Move:
J/L = X- / X+
I/K = Y+ / Y-
U/O = Z- / Z+

Scale:
N/M = size- / size+

Rotate:
[/] = pitch- / pitch+
;/' = yaw- / yaw+
,/. = roll- / roll+

P = print values

desiredMaxDimension: ${M16_DEBUG_TUNER.desiredMaxDimension.toFixed(3)}

position:
x: ${p.x.toFixed(3)}
y: ${p.y.toFixed(3)}
z: ${p.z.toFixed(3)}

rotation:
x: ${r.x.toFixed(3)}
y: ${r.y.toFixed(3)}
z: ${r.z.toFixed(3)}
`;
}

function logM16TuningValues(): void {
  const p = M16_DEBUG_TUNER.position;
  const r = M16_DEBUG_TUNER.rotation;

  console.info(
`const M16_VIEWMODEL_TUNE = {
  desiredMaxDimension: ${M16_DEBUG_TUNER.desiredMaxDimension.toFixed(3)},
  position: new THREE.Vector3(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}),
  rotation: new THREE.Euler(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)}),
  idleTime: 0.05,
};`
  );
}

function applyM16DebugTransform(): void {
  if (!currentM16Wrapper) return;
  currentM16Wrapper.position.copy(M16_DEBUG_TUNER.position);
  currentM16Wrapper.rotation.copy(M16_DEBUG_TUNER.rotation);
}

function onM16DebugKeyDown(ev: KeyboardEvent): void {
  if (!M16_DEBUG_TUNER.enabled) return;
  if (!currentM16Wrapper) return;
  if (currentWeaponId !== 'assault_rifle') return;

  const tag = (ev.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const posStep = ev.shiftKey ? 0.02 : 0.005;
  const rotStep = ev.shiftKey ? 0.08 : 0.02;
  const scaleStep = ev.shiftKey ? 0.05 : 0.01;

  let changed = true;
  let sizeChanged = false;

  switch (ev.key) {
    case 'j':
    case 'J':
      M16_DEBUG_TUNER.position.x -= posStep;
      break;
    case 'l':
    case 'L':
      M16_DEBUG_TUNER.position.x += posStep;
      break;
    case 'i':
    case 'I':
      M16_DEBUG_TUNER.position.y += posStep;
      break;
    case 'k':
    case 'K':
      M16_DEBUG_TUNER.position.y -= posStep;
      break;
    case 'u':
    case 'U':
      M16_DEBUG_TUNER.position.z -= posStep;
      break;
    case 'o':
    case 'O':
      M16_DEBUG_TUNER.position.z += posStep;
      break;

    case 'n':
    case 'N':
      M16_DEBUG_TUNER.desiredMaxDimension = Math.max(0.05, M16_DEBUG_TUNER.desiredMaxDimension - scaleStep);
      sizeChanged = true;
      break;
    case 'm':
    case 'M':
      M16_DEBUG_TUNER.desiredMaxDimension += scaleStep;
      sizeChanged = true;
      break;

    case '[':
      M16_DEBUG_TUNER.rotation.x -= rotStep;
      break;
    case ']':
      M16_DEBUG_TUNER.rotation.x += rotStep;
      break;
    case ';':
      M16_DEBUG_TUNER.rotation.y -= rotStep;
      break;
    case "'":
      M16_DEBUG_TUNER.rotation.y += rotStep;
      break;
    case ',':
      M16_DEBUG_TUNER.rotation.z -= rotStep;
      break;
    case '.':
      M16_DEBUG_TUNER.rotation.z += rotStep;
      break;

    case 'p':
    case 'P':
      logM16TuningValues();
      changed = false;
      break;

    default:
      changed = false;
      break;
  }

  if (!changed) return;

  ev.preventDefault();

  if (sizeChanged) {
    applyWeaponSwap('assault_rifle');
  } else {
    applyM16DebugTransform();
  }

  refreshM16DebugOverlay();
}

function holdAnimatedPose(weaponId: AnimatedWeaponId): void {
  if (currentAnimatedWeaponId !== weaponId) return;
  if (!currentViewmodelMixer || currentViewmodelActions.length === 0) return;

  const cfg = ANIMATED_VIEWMODEL_CONFIGS[weaponId];
  const action = currentViewmodelActions[0];

  currentAnimatedAction = action;
  activeAnimatedRange = null;

  action.enabled = true;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.play();
  action.paused = true;
  action.time = cfg.holdTime;

  currentViewmodelMixer.update(0);
}

function playAnimatedRange(weaponId: AnimatedWeaponId, name: AnimatedRangeName, timeScale = 1): void {
  if (currentAnimatedWeaponId !== weaponId) return;
  if (!currentViewmodelMixer || currentViewmodelActions.length === 0) return;

  const cfg = ANIMATED_VIEWMODEL_CONFIGS[weaponId];
  const range = cfg.ranges[name];
  if (!range) return;

  const action = currentViewmodelActions[0];
  const [start] = range;

  currentAnimatedAction = action;
  activeAnimatedRange = name;

  action.reset();
  action.enabled = true;
  action.paused = false;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.timeScale = timeScale;
  action.play();
  action.time = start;

  currentViewmodelMixer.update(0);
}


function clearCurrentWeaponMesh(): void {
  if (currentWeaponMesh) {
    vmGroup.remove(currentWeaponMesh);
    currentWeaponMesh = null;
  }

  currentM16Wrapper = null;
  currentSMGWrapper = null;
  currentAnimatedWeaponId = null;
  activeAnimatedRange = null;
  currentAnimatedAction = null;
  wasReloading = false;

  currentKnifeWrapper = null;
  activeKnifeRange = null;
  currentKnifeAction = null;

  if (currentViewmodelActions.length > 0) {
    for (const action of currentViewmodelActions) {
      action.stop();
    }
    currentViewmodelActions = [];
  }

  if (currentViewmodelMixer) {
    currentViewmodelMixer.stopAllAction();
    if (currentWeaponMesh) {
      currentViewmodelMixer.uncacheRoot(currentWeaponMesh);
    }
    currentViewmodelMixer = null;
  }
}

function attachLoadedAnimatedWeapon(weaponId: AnimatedWeaponId): void {
  const cached = cachedAnimated.get(weaponId);
  if (!cached) {
    applyProceduralWeapon(weaponId);
    return;
  }

  const cfg = ANIMATED_VIEWMODEL_CONFIGS[weaponId];
  const cloneRoot = skeletonClone(cached.scene) as THREE.Group;
  prepRenderable(cloneRoot);

  const rawBox = new THREE.Box3().setFromObject(cloneRoot);
  const rawSize = new THREE.Vector3();
  const rawCenter = new THREE.Vector3();
  rawBox.getSize(rawSize);
  rawBox.getCenter(rawCenter);

  if (weaponId === 'assault_rifle') {
    console.info('[WeaponViewmodel] M16 raw bounds size:', rawSize.toArray());
    console.info('[WeaponViewmodel] M16 raw bounds center:', rawCenter.toArray());
  }

  const isM16Tuning = weaponId === 'assault_rifle' && M16_DEBUG_TUNER.enabled;
  const isSMGTuning = weaponId === 'smg' && SMG_DEBUG_TUNER.enabled;
  const desiredDim = isM16Tuning ? M16_DEBUG_TUNER.desiredMaxDimension
    : isSMGTuning ? SMG_DEBUG_TUNER.desiredMaxDimension
    : cfg.desiredMaxDimension;
  const wrapper = normalizeViewmodelWrapper(
    cloneRoot,
    desiredDim,
    isM16Tuning ? M16_DEBUG_TUNER.position : isSMGTuning ? SMG_DEBUG_TUNER.position : cfg.position,
    isM16Tuning ? M16_DEBUG_TUNER.rotation : isSMGTuning ? SMG_DEBUG_TUNER.rotation : cfg.rotation,
  );

  wrapper.name = `${weaponId}ViewmodelWrapper`;

  if (weaponId === 'assault_rifle') {
    currentM16Wrapper = wrapper;
    currentSMGWrapper = null;
  } else if (weaponId === 'smg') {
    currentSMGWrapper = wrapper;
    currentM16Wrapper = null;
  } else {
    currentM16Wrapper = null;
    currentSMGWrapper = null;
  }

  currentAnimatedWeaponId = weaponId;
  currentWeaponMesh = wrapper;
  vmGroup.add(currentWeaponMesh);

  currentViewmodelMixer = null;
  currentViewmodelActions = [];
  currentAnimatedAction = null;
  activeAnimatedRange = null;

  if (cached.animations.length > 0) {
    currentViewmodelMixer = new THREE.AnimationMixer(cloneRoot);
    currentViewmodelActions = cached.animations.map((clip) =>
      currentViewmodelMixer!.clipAction(clip),
    );

    if (cfg.ranges.equip) {
      playAnimatedRange(weaponId, 'equip', 1.0);
    } else {
      holdAnimatedPose(weaponId);
    }
  }

  if (weaponId === 'assault_rifle') {
    const finalBox = new THREE.Box3().setFromObject(wrapper);
    const finalSize = new THREE.Vector3();
    const finalCenter = new THREE.Vector3();
    finalBox.getSize(finalSize);
    finalBox.getCenter(finalCenter);

    console.info('[WeaponViewmodel] M16 final bounds size:', finalSize.toArray());
    console.info('[WeaponViewmodel] M16 final bounds center:', finalCenter.toArray());

    refreshM16DebugOverlay();
  }

  if (weaponId === 'smg') {
    refreshSMGDebugOverlay();
  }
}

function ensureSMGDebugOverlay(): void {
  if (!SMG_DEBUG_TUNER.enabled) return;
  if (smgDebugOverlay) return;

  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.left = '12px';
  el.style.bottom = '12px';
  el.style.zIndex = '99999';
  el.style.padding = '10px 12px';
  el.style.background = 'rgba(0,0,0,0.75)';
  el.style.color = '#a0ffb0';
  el.style.fontFamily = 'monospace';
  el.style.fontSize = '12px';
  el.style.lineHeight = '1.45';
  el.style.border = '1px solid rgba(100,255,130,0.45)';
  el.style.borderRadius = '8px';
  el.style.whiteSpace = 'pre';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);

  smgDebugOverlay = el;
  refreshSMGDebugOverlay();
}

function refreshSMGDebugOverlay(): void {
  if (!smgDebugOverlay || !SMG_DEBUG_TUNER.enabled) return;

  const p = SMG_DEBUG_TUNER.position;
  const r = SMG_DEBUG_TUNER.rotation;

  smgDebugOverlay.textContent =
`SMG VIEWMODEL TUNER

Move:
J/L = X- / X+
I/K = Y+ / Y-
U/O = Z- / Z+

Scale:
N/M = size- / size+

Rotate:
[/] = pitch- / pitch+
;/' = yaw- / yaw+
,/. = roll- / roll+

P = print values

desiredMaxDimension: ${SMG_DEBUG_TUNER.desiredMaxDimension.toFixed(3)}

position:
x: ${p.x.toFixed(3)}
y: ${p.y.toFixed(3)}
z: ${p.z.toFixed(3)}

rotation:
x: ${r.x.toFixed(3)}
y: ${r.y.toFixed(3)}
z: ${r.z.toFixed(3)}
`;
}

function logSMGTuningValues(): void {
  const p = SMG_DEBUG_TUNER.position;
  const r = SMG_DEBUG_TUNER.rotation;

  console.info(
`// Paste into ANIMATED_VIEWMODEL_CONFIGS.smg:
desiredMaxDimension: ${SMG_DEBUG_TUNER.desiredMaxDimension.toFixed(3)},
position: new THREE.Vector3(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}),
rotation: new THREE.Euler(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)}),`
  );
}

function applySMGDebugTransform(): void {
  if (!currentSMGWrapper) return;
  currentSMGWrapper.position.copy(SMG_DEBUG_TUNER.position);
  currentSMGWrapper.rotation.copy(SMG_DEBUG_TUNER.rotation);
}

function onSMGDebugKeyDown(ev: KeyboardEvent): void {
  if (!SMG_DEBUG_TUNER.enabled) return;
  if (!currentSMGWrapper) return;
  if (currentWeaponId !== 'smg') return;

  const tag = (ev.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const posStep = ev.shiftKey ? 0.02 : 0.005;
  const rotStep = ev.shiftKey ? 0.08 : 0.02;
  const scaleStep = ev.shiftKey ? 0.05 : 0.01;

  let changed = true;
  let sizeChanged = false;

  switch (ev.key) {
    case 'j':
    case 'J':
      SMG_DEBUG_TUNER.position.x -= posStep;
      break;
    case 'l':
    case 'L':
      SMG_DEBUG_TUNER.position.x += posStep;
      break;
    case 'i':
    case 'I':
      SMG_DEBUG_TUNER.position.y += posStep;
      break;
    case 'k':
    case 'K':
      SMG_DEBUG_TUNER.position.y -= posStep;
      break;
    case 'u':
    case 'U':
      SMG_DEBUG_TUNER.position.z -= posStep;
      break;
    case 'o':
    case 'O':
      SMG_DEBUG_TUNER.position.z += posStep;
      break;

    case 'n':
    case 'N':
      SMG_DEBUG_TUNER.desiredMaxDimension = Math.max(0.05, SMG_DEBUG_TUNER.desiredMaxDimension - scaleStep);
      sizeChanged = true;
      break;
    case 'm':
    case 'M':
      SMG_DEBUG_TUNER.desiredMaxDimension += scaleStep;
      sizeChanged = true;
      break;

    case '[':
      SMG_DEBUG_TUNER.rotation.x -= rotStep;
      break;
    case ']':
      SMG_DEBUG_TUNER.rotation.x += rotStep;
      break;
    case ';':
      SMG_DEBUG_TUNER.rotation.y -= rotStep;
      break;
    case "'":
      SMG_DEBUG_TUNER.rotation.y += rotStep;
      break;
    case ',':
      SMG_DEBUG_TUNER.rotation.z -= rotStep;
      break;
    case '.':
      SMG_DEBUG_TUNER.rotation.z += rotStep;
      break;

    case 'p':
    case 'P':
      logSMGTuningValues();
      changed = false;
      break;

    default:
      changed = false;
      break;
  }

  if (!changed) return;

  ev.preventDefault();

  if (sizeChanged) {
    applyWeaponSwap('smg');
  } else {
    applySMGDebugTransform();
  }

  refreshSMGDebugOverlay();
}

function ensureKnifeDebugOverlay(): void {
  if (!KNIFE_DEBUG_TUNER.enabled) return;
  if (knifeDebugOverlay) return;

  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.right = '12px';
  el.style.bottom = '12px';
  el.style.zIndex = '99999';
  el.style.padding = '10px 12px';
  el.style.background = 'rgba(0,0,0,0.75)';
  el.style.color = '#ffe09f';
  el.style.fontFamily = 'monospace';
  el.style.fontSize = '12px';
  el.style.lineHeight = '1.45';
  el.style.border = '1px solid rgba(255,200,100,0.45)';
  el.style.borderRadius = '8px';
  el.style.whiteSpace = 'pre';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);

  knifeDebugOverlay = el;
  refreshKnifeDebugOverlay();
}

function refreshKnifeDebugOverlay(): void {
  if (!knifeDebugOverlay || !KNIFE_DEBUG_TUNER.enabled) return;

  const p = KNIFE_DEBUG_TUNER.position;
  const r = KNIFE_DEBUG_TUNER.rotation;

  knifeDebugOverlay.textContent =
`KNIFE VIEWMODEL TUNER

Move:
J/L = X- / X+
I/K = Y+ / Y-
U/O = Z- / Z+

Scale:
N/M = size- / size+

Rotate:
[/] = pitch- / pitch+
;/' = yaw- / yaw+
,/. = roll- / roll+

P = print values

desiredMaxDimension: ${KNIFE_DEBUG_TUNER.desiredMaxDimension.toFixed(3)}

position:
x: ${p.x.toFixed(3)}
y: ${p.y.toFixed(3)}
z: ${p.z.toFixed(3)}

rotation:
x: ${r.x.toFixed(3)}
y: ${r.y.toFixed(3)}
z: ${r.z.toFixed(3)}
`;
}

function logKnifeTuningValues(): void {
  const p = KNIFE_DEBUG_TUNER.position;
  const r = KNIFE_DEBUG_TUNER.rotation;

  console.info(
`const KNIFE_VIEWMODEL_TUNE = {
  desiredMaxDimension: ${KNIFE_DEBUG_TUNER.desiredMaxDimension.toFixed(3)},
  position: new THREE.Vector3(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}),
  rotation: new THREE.Euler(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)}),
  idleTime: 0.00,
};`
  );
}

function applyKnifeDebugTransform(): void {
  if (!currentKnifeWrapper) return;
  currentKnifeWrapper.position.copy(KNIFE_DEBUG_TUNER.position);
  currentKnifeWrapper.rotation.copy(KNIFE_DEBUG_TUNER.rotation);
}

function onKnifeDebugKeyDown(ev: KeyboardEvent): void {
  if (!KNIFE_DEBUG_TUNER.enabled) return;
  if (!currentKnifeWrapper) return;
  if (currentWeaponId !== 'knife') return;

  const tag = (ev.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const posStep = ev.shiftKey ? 0.02 : 0.005;
  const rotStep = ev.shiftKey ? 0.08 : 0.02;
  const scaleStep = ev.shiftKey ? 0.05 : 0.01;

  let changed = true;
  let sizeChanged = false;

  switch (ev.key) {
    case 'j':
    case 'J':
      KNIFE_DEBUG_TUNER.position.x -= posStep;
      break;
    case 'l':
    case 'L':
      KNIFE_DEBUG_TUNER.position.x += posStep;
      break;
    case 'i':
    case 'I':
      KNIFE_DEBUG_TUNER.position.y += posStep;
      break;
    case 'k':
    case 'K':
      KNIFE_DEBUG_TUNER.position.y -= posStep;
      break;
    case 'u':
    case 'U':
      KNIFE_DEBUG_TUNER.position.z -= posStep;
      break;
    case 'o':
    case 'O':
      KNIFE_DEBUG_TUNER.position.z += posStep;
      break;

    case 'n':
    case 'N':
      KNIFE_DEBUG_TUNER.desiredMaxDimension = Math.max(0.05, KNIFE_DEBUG_TUNER.desiredMaxDimension - scaleStep);
      sizeChanged = true;
      break;
    case 'm':
    case 'M':
      KNIFE_DEBUG_TUNER.desiredMaxDimension += scaleStep;
      sizeChanged = true;
      break;

    case '[':
      KNIFE_DEBUG_TUNER.rotation.x -= rotStep;
      break;
    case ']':
      KNIFE_DEBUG_TUNER.rotation.x += rotStep;
      break;
    case ';':
      KNIFE_DEBUG_TUNER.rotation.y -= rotStep;
      break;
    case "'":
      KNIFE_DEBUG_TUNER.rotation.y += rotStep;
      break;
    case ',':
      KNIFE_DEBUG_TUNER.rotation.z -= rotStep;
      break;
    case '.':
      KNIFE_DEBUG_TUNER.rotation.z += rotStep;
      break;

    case 'p':
    case 'P':
      logKnifeTuningValues();
      changed = false;
      break;

    default:
      changed = false;
      break;
  }

  if (!changed) return;

  ev.preventDefault();

  if (sizeChanged) {
    applyWeaponSwap('knife');
  } else {
    applyKnifeDebugTransform();
  }

  refreshKnifeDebugOverlay();
}

function holdKnifeIdlePose(): void {
  if (!currentViewmodelMixer || currentViewmodelActions.length === 0) return;

  const action = currentViewmodelActions[0];
  currentKnifeAction = action;
  activeKnifeRange = 'idle';

  action.reset();
  action.enabled = true;
  action.clampWhenFinished = false;
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.timeScale = 1;
  action.play();
  action.time = KNIFE_RANGES.idle[0];

  currentViewmodelMixer.update(0);
}

function playKnifeRange(name: KnifeRangeName, timeScale = 1): void {
  if (currentWeaponId !== 'knife') return;
  if (!currentViewmodelMixer || currentViewmodelActions.length === 0) return;

  const action = currentViewmodelActions[0];
  const [start] = KNIFE_RANGES[name];

  currentKnifeAction = action;
  activeKnifeRange = name;

  action.reset();
  action.enabled = true;
  action.paused = false;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.timeScale = timeScale;
  action.play();
  action.time = start;

  currentViewmodelMixer.update(0);
}

function attachLoadedKnife(): void {
  if (!cachedKnife) {
    applyProceduralWeapon('knife');
    return;
  }

  const cloneRoot = skeletonClone(cachedKnife.scene) as THREE.Group;
  prepRenderable(cloneRoot);
  const wrapper = normalizeViewmodelWrapper(
    cloneRoot,
    KNIFE_DEBUG_TUNER.enabled ? KNIFE_DEBUG_TUNER.desiredMaxDimension : KNIFE_VIEWMODEL_TUNE.desiredMaxDimension,
    KNIFE_DEBUG_TUNER.enabled ? KNIFE_DEBUG_TUNER.position : KNIFE_VIEWMODEL_TUNE.position,
    KNIFE_DEBUG_TUNER.enabled ? KNIFE_DEBUG_TUNER.rotation : KNIFE_VIEWMODEL_TUNE.rotation,
  );
  wrapper.name = 'KnifeViewmodelWrapper';

  currentKnifeWrapper = wrapper;
  currentWeaponMesh = wrapper;
  vmGroup.add(currentWeaponMesh);

  currentViewmodelMixer = null;
  currentViewmodelActions = [];
  currentKnifeAction = null;
  activeKnifeRange = null;

  if (cachedKnife.animations.length > 0) {
    currentViewmodelMixer = new THREE.AnimationMixer(cloneRoot);
    currentViewmodelActions = cachedKnife.animations.map((clip) =>
      currentViewmodelMixer!.clipAction(clip),
    );

    playKnifeRange('equip', 1.0);
  }

  refreshKnifeDebugOverlay();
}

function applyProceduralWeapon(weaponId: WeaponId): void {
  currentWeaponMesh = cloneProceduralWeapon(weaponId);
  const layout = VM_LAYOUTS[weaponId];
  currentWeaponMesh.scale.setScalar(layout.scale);
  vmGroup.add(currentWeaponMesh);
}

function applyWeaponSwap(weaponId: WeaponId): void {
  clearCurrentWeaponMesh();

  currentWeaponId = weaponId;

  // Hide muzzle flash objects for weapons that don't need them —
  // the invisible sphere still writes to the depth buffer and occludes arm geometry.
  const hasMuzzle = weaponId !== 'knife' && weaponId !== 'unarmed';
  vmMuzzleFlash.visible = hasMuzzle;
  vmMuzzleMesh.visible = hasMuzzle;
  vmMuzzleSprite.visible = hasMuzzle;

  // Secondary muzzle (dual-barrel weapons only)
  const hasSecondaryMuzzle = hasMuzzle && !!VM_LAYOUTS[weaponId].muzzleOffsetSecondary;
  vmMuzzleFlash2.visible = hasSecondaryMuzzle;
  vmMuzzleMesh2.visible = hasSecondaryMuzzle;
  vmMuzzleSprite2.visible = hasSecondaryMuzzle;

  if (isAnimatedWeapon(weaponId) && cachedAnimated.get(weaponId)) {
    attachLoadedAnimatedWeapon(weaponId);
  } else if (weaponId === 'knife' && cachedKnife) {
    attachLoadedKnife();
  } else {
    const layout = VM_LAYOUTS[weaponId];
    applyProceduralWeapon(weaponId);
    if (currentWeaponMesh) {
      currentWeaponMesh.scale.setScalar(layout.scale);
    }
  }

  recoilZ = 0;
  recoilUp = 0;
  recoilRot = 0;
}

async function tryLoadSpecialViewmodel(weaponId: WeaponId): Promise<void> {
  if (isAnimatedWeapon(weaponId)) {
    const loaded = await loadAnimatedViewmodel(weaponId);
    if (!loaded) return;
    if (currentWeaponId === weaponId || pendingWeaponId === weaponId) {
      applyWeaponSwap(weaponId);
      pendingWeaponId = null;
      switchDir = 'up';
      switchProgress = 1;
    }
  } else if (weaponId === 'knife') {
    const loaded = await loadKnifeViewmodel();
    if (!loaded) return;
    if (currentWeaponId === 'knife' || pendingWeaponId === 'knife') {
      applyWeaponSwap('knife');
      pendingWeaponId = null;
      switchDir = 'up';
      switchProgress = 1;
    }
  }
}

/**
 * Preload all animated viewmodel GLBs (+ knife) up-front so the loading
 * screen actually covers the asset download cost. Without this, the
 * first weapon the player equips triggers an async fetch mid-game.
 *
 * Safe to call multiple times — `loadAnimatedViewmodel` / `loadKnifeViewmodel`
 * return cached results once loaded. Errors are swallowed (the
 * individual loaders fall back to procedural meshes).
 */
export async function preloadViewmodels(): Promise<void> {
  const animatedIds: AnimatedWeaponId[] = ['assault_rifle', 'pistol', 'shotgun', 'sniper_rifle', 'rocket_launcher', 'smg'];
  for (const weaponId of ALL_VIEWMODEL_WEAPON_IDS) {
    if (weaponId === 'knife' || isAnimatedWeapon(weaponId)) continue;
    getProceduralWeaponTemplate(weaponId);
  }
  await Promise.all([
    ...animatedIds.map((id) => loadAnimatedViewmodel(id).catch(() => null)),
    loadKnifeViewmodel().catch(() => null),
  ]);
}

export async function precompileViewmodelScene(): Promise<void> {
  if (!vmScene || !vmCamera || !gameState.renderer) return;

  const renderer = gameState.renderer;
  const compile = async () => {
    if (typeof (renderer as any).compileAsync === 'function') {
      await (renderer as any).compileAsync(vmScene, vmCamera);
    } else {
      renderer.compile(vmScene, vmCamera);
    }
  };

  const warmupGroup = new THREE.Group();
  const prevVisible = vmGroup.visible;
  const prevFlashIntensity = vmMuzzleFlash.intensity;
  const prevMeshOpacity = (vmMuzzleMesh.material as THREE.MeshBasicMaterial).opacity;
  const prevSpriteOpacity = (vmMuzzleSprite.material as THREE.SpriteMaterial).opacity;
  const prevSpriteScale = vmMuzzleSprite.scale.clone();

  vmScene.add(warmupGroup);

  try {
    vmGroup.visible = true;

    for (const weaponId of ALL_VIEWMODEL_WEAPON_IDS) {
      const variant = createViewmodelWarmupVariant(weaponId);
      if (!variant) continue;
      warmupGroup.add(variant);
      await compile();
      warmupGroup.remove(variant);
      warmupGroup.clear();
    }

    vmMuzzleFlash.intensity = 2;
    (vmMuzzleMesh.material as THREE.MeshBasicMaterial).opacity = 1;
    (vmMuzzleSprite.material as THREE.SpriteMaterial).opacity = 0.9;
    vmMuzzleSprite.scale.set(0.12, 0.12, 1);
    await compile();
  } finally {
    vmScene.remove(warmupGroup);
    warmupGroup.clear();
    vmGroup.visible = prevVisible;
    vmMuzzleFlash.intensity = prevFlashIntensity;
    (vmMuzzleMesh.material as THREE.MeshBasicMaterial).opacity = prevMeshOpacity;
    (vmMuzzleSprite.material as THREE.SpriteMaterial).opacity = prevSpriteOpacity;
    vmMuzzleSprite.scale.copy(prevSpriteScale);
  }
}

export function setViewmodelWeapon(weaponId: WeaponId, forceSwap = false): void {
  if (!vmGroup) {
    currentWeaponId = weaponId;
    return;
  }

  if (!forceSwap && weaponId === currentWeaponId && currentWeaponMesh && switchProgress >= 1) return;

  pendingWeaponId = weaponId;
  switchDir = 'down';

  void tryLoadSpecialViewmodel(weaponId);
}

export function setViewmodelVisible(visible: boolean): void {
  vmHidden = !visible;
  if (vmGroup) vmGroup.visible = visible;
}

export function initViewmodel(): void {
  vmScene = new THREE.Scene();

  vmScene.add(new THREE.AmbientLight(0xccddff, 0.7));
  const dl = new THREE.DirectionalLight(0xffffff, 1.0);
  dl.position.set(2, 3, 4);
  vmScene.add(dl);

  const rim = new THREE.DirectionalLight(0x38bdf8, 0.3);
  rim.position.set(-2, 1, -1);
  vmScene.add(rim);

  vmCamera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 10);

  vmGroup = new THREE.Group();
  vmScene.add(vmGroup);

  vmMuzzleFlash = new THREE.PointLight(0xffaa33, 0, 4);
  vmGroup.add(vmMuzzleFlash);

  vmMuzzleMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffdd55, transparent: true, opacity: 0 }),
  );
  vmGroup.add(vmMuzzleMesh);

  const flashMat = new THREE.SpriteMaterial({
    color: 0xffcc44,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  });
  vmMuzzleSprite = new THREE.Sprite(flashMat);
  vmMuzzleSprite.scale.set(0.08, 0.08, 1);
  vmGroup.add(vmMuzzleSprite);

  // ── Secondary muzzle (dual-barrel weapons) ──
  vmMuzzleFlash2 = new THREE.PointLight(0xffaa33, 0, 4);
  vmMuzzleFlash2.visible = false;
  vmGroup.add(vmMuzzleFlash2);

  vmMuzzleMesh2 = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffdd55, transparent: true, opacity: 0 }),
  );
  vmMuzzleMesh2.visible = false;
  vmGroup.add(vmMuzzleMesh2);

  const flashMat2 = new THREE.SpriteMaterial({
    color: 0xffcc44,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  });
  vmMuzzleSprite2 = new THREE.Sprite(flashMat2);
  vmMuzzleSprite2.scale.set(0.08, 0.08, 1);
  vmMuzzleSprite2.visible = false;
  vmGroup.add(vmMuzzleSprite2);

  if (M16_DEBUG_TUNER.enabled) {
    ensureM16DebugOverlay();
    window.addEventListener('keydown', onM16DebugKeyDown);
  }

  if (SMG_DEBUG_TUNER.enabled) {
    ensureSMGDebugOverlay();
    window.addEventListener('keydown', onSMGDebugKeyDown);
  }

  if (KNIFE_DEBUG_TUNER.enabled) {
    ensureKnifeDebugOverlay();
    window.addEventListener('keydown', onKnifeDebugKeyDown);
  }

  setViewmodelWeapon(gameState.pWeaponId);
}

export function fireViewmodel(): void {
  if (currentWeaponId === 'unarmed') return;

  if (currentWeaponId === 'knife') {
    if (currentViewmodelMixer) {
      const sliceAnims: KnifeRangeName[] = ['slice1', 'slice2', 'slice3'];
      const pick = sliceAnims[Math.floor(Math.random() * sliceAnims.length)];
      playKnifeRange(pick, 1.0);
    }
    return;
  }

  const layout = VM_LAYOUTS[currentWeaponId];

  recoilZ = layout.recoilZ;
  recoilUp = layout.recoilUp;
  recoilRot = layout.recoilRot;

  vmMuzzleFlash.intensity = 6;
  (vmMuzzleMesh.material as THREE.MeshBasicMaterial).opacity = 1.0;
  (vmMuzzleSprite.material as THREE.SpriteMaterial).opacity = 0.9;
  vmMuzzleSprite.scale.set(0.12, 0.12, 1);
  vmMuzzleSprite.material.rotation = Math.random() * Math.PI * 2;

  // Dual-barrel weapons (e.g. dual MAC-10): fire the second muzzle in sync
  if (layout.muzzleOffsetSecondary) {
    vmMuzzleFlash2.intensity = 6;
    (vmMuzzleMesh2.material as THREE.MeshBasicMaterial).opacity = 1.0;
    (vmMuzzleSprite2.material as THREE.SpriteMaterial).opacity = 0.9;
    vmMuzzleSprite2.scale.set(0.12, 0.12, 1);
    vmMuzzleSprite2.material.rotation = Math.random() * Math.PI * 2;
  }

  // Shell casing ejection (hitscan weapons only — not rockets)
  if (currentWeaponId !== 'rocket_launcher') {
    const cam = gameState.camera;
    const right = new THREE.Vector3();
    cam.getWorldDirection(right);
    right.cross(cam.up).normalize();
    const ejectionPt = cam.position.clone().add(right.clone().multiplyScalar(0.15)).add(new THREE.Vector3(0, -0.05, 0));
    spawnShellCasing(ejectionPt, right);
    // Dual-barrel weapons eject a second casing from the opposite side
    if (layout.muzzleOffsetSecondary) {
      const leftDir = right.clone().multiplyScalar(-1);
      const ejectionPt2 = cam.position.clone().add(leftDir.clone().multiplyScalar(0.15)).add(new THREE.Vector3(0, -0.05, 0));
      spawnShellCasing(ejectionPt2, leftDir);
    }
  }

  const kickUp = layout.recoilRot * 0.4 + Math.random() * layout.recoilRot * 0.15
    + climbShots * layout.climbPerShot;
  const kickSide = (Math.random() - 0.5) * layout.recoilRot * 0.15;
  gameState.recoilPitch += kickUp;
  gameState.recoilYaw += kickSide;
  gameState.recoilRecoveryPitch += kickUp;
  gameState.recoilRecoveryYaw += kickSide;
  climbShots++;
  climbResetTimer = 0.25; // reset climb if no shot within 250ms
  lastActivityTime = gameState.worldElapsed;
  inspectPhase = 0;

  if (isAnimatedWeapon(currentWeaponId) && currentViewmodelMixer) {
    playAnimatedRange(currentWeaponId, 'shoot', 1.0);
  }
}

export function playViewmodelHit(): void {
  if (isAnimatedWeapon(currentWeaponId) && currentViewmodelMixer) {
    playAnimatedRange(currentWeaponId, 'hit', 1.0);
  }
}

export function updateViewmodel(dt: number): void {
  if (!vmGroup) return;

  // Decay recoil climb counter when not firing
  if (climbResetTimer > 0) {
    climbResetTimer -= dt;
    if (climbResetTimer <= 0) climbShots = 0;
  }

  const { keys, pDead, pReloading, mouseDeltaX, mouseDeltaY } = gameState;
  const isMoving = keys.w || keys.a || keys.s || keys.d;
  const isSprinting = keys.shift && isMoving;

  if (isAnimatedWeapon(currentWeaponId)) {
    if (pReloading && !wasReloading && currentViewmodelMixer) {
      playAnimatedRange(currentWeaponId, 'reload', 1.0);
    }
    wasReloading = pReloading;
  } else {
    wasReloading = false;
  }

  if (currentViewmodelMixer) {
    currentViewmodelMixer.update(dt);

    if (isAnimatedWeapon(currentWeaponId) && activeAnimatedRange && currentAnimatedAction) {
      const range = ANIMATED_VIEWMODEL_CONFIGS[currentWeaponId].ranges[activeAnimatedRange];
      if (range && currentAnimatedAction.time >= range[1]) {
        holdAnimatedPose(currentWeaponId);
      }
    }

    if (currentWeaponId === 'knife' && activeKnifeRange && currentKnifeAction) {
      const [, end] = KNIFE_RANGES[activeKnifeRange];
      if (currentKnifeAction.time >= end) {
        holdKnifeIdlePose();
      }
      // Keep idle animation looping within its range
      if (activeKnifeRange === 'idle' && currentKnifeAction.time >= end) {
        currentKnifeAction.time = KNIFE_RANGES.idle[0];
      }
    }
  }

  if (pDead || vmHidden) {
    vmGroup.visible = false;
    return;
  }
  vmGroup.visible = true;

  const layout = VM_LAYOUTS[currentWeaponId];

  if (switchDir === 'down') {
    switchProgress = Math.max(0, switchProgress - dt * 6);
    if (switchProgress <= 0 && pendingWeaponId) {
      applyWeaponSwap(pendingWeaponId);
      pendingWeaponId = null;
      switchDir = 'up';
    }
  } else if (switchDir === 'up' && switchProgress < 1) {
    const drawSpd = WEAPONS[currentWeaponId]?.drawSpeed ?? 5;
    switchProgress = Math.min(1, switchProgress + dt * drawSpd);
  }

  if (isMoving) {
    bobPhase += dt * (isSprinting ? 15 : 10);
  } else {
    bobPhase += dt * 1.8;
  }

  const baseBob = isMoving ? (isSprinting ? 0.008 : 0.004) : 0.0012;
  const bobAmt = baseBob * layout.bobMul;
  const bobX = Math.sin(bobPhase) * bobAmt;
  const bobY = Math.abs(Math.cos(bobPhase * 2)) * bobAmt * 0.7;

  const targetSwayX = -mouseDeltaX * 0.0008;
  const targetSwayY = -mouseDeltaY * 0.0008;
  swayX += (targetSwayX - swayX) * Math.min(1, dt * 12);
  swayY += (targetSwayY - swayY) * Math.min(1, dt * 12);
  swayX *= Math.max(0, 1 - dt * 5);
  swayY *= Math.max(0, 1 - dt * 5);

  const sprintTarget = isSprinting ? 1 : 0;
  sprintLerp += (sprintTarget - sprintLerp) * Math.min(1, dt * 8);

  const reloadTarget = pReloading ? 1 : 0;
  reloadLerp += (reloadTarget - reloadLerp) * Math.min(1, dt * 6);

  recoilZ *= Math.max(0, 1 - dt * 15);
  recoilUp *= Math.max(0, 1 - dt * 13);
  recoilRot *= Math.max(0, 1 - dt * 14);

  const recoverySpeed = dt * 8;
  if (Math.abs(gameState.recoilRecoveryPitch) > 0.0001) {
    const recover = gameState.recoilRecoveryPitch * Math.min(1, recoverySpeed);
    gameState.cameraPitch -= recover;
    gameState.recoilRecoveryPitch -= recover;
  }
  if (Math.abs(gameState.recoilRecoveryYaw) > 0.0001) {
    const recover = gameState.recoilRecoveryYaw * Math.min(1, recoverySpeed);
    gameState.cameraYaw -= recover;
    gameState.recoilRecoveryYaw -= recover;
  }

  vmMuzzleFlash.intensity *= Math.max(0, 1 - dt * 25);
  const flashMat = vmMuzzleMesh.material as THREE.MeshBasicMaterial;
  flashMat.opacity *= Math.max(0, 1 - dt * 20);
  const spriteMat = vmMuzzleSprite.material as THREE.SpriteMaterial;
  spriteMat.opacity *= Math.max(0, 1 - dt * 18);
  vmMuzzleSprite.scale.multiplyScalar(Math.max(0.8, 1 - dt * 8));

  // Secondary muzzle decay (only relevant when visible, but cheap to always run)
  if (vmMuzzleFlash2.visible) {
    vmMuzzleFlash2.intensity *= Math.max(0, 1 - dt * 25);
    const flashMat2b = vmMuzzleMesh2.material as THREE.MeshBasicMaterial;
    flashMat2b.opacity *= Math.max(0, 1 - dt * 20);
    const spriteMat2 = vmMuzzleSprite2.material as THREE.SpriteMaterial;
    spriteMat2.opacity *= Math.max(0, 1 - dt * 18);
    vmMuzzleSprite2.scale.multiplyScalar(Math.max(0.8, 1 - dt * 8));
  }

  const switchDrop = (1 - easeOutCubic(switchProgress)) * 0.15;
  const reloadDrop = reloadLerp * 0.08;
  const reloadTilt = reloadLerp * 0.6;

  // ── Empty magazine bolt-lock visual ──
  const magEmpty = gameState.pAmmo <= 0 && !pReloading && !pDead
    && currentWeaponId !== 'unarmed' && currentWeaponId !== 'knife'
    && currentWeaponId !== 'rocket_launcher';
  const boltLockTarget = magEmpty ? 1 : 0;
  boltLockLerp += (boltLockTarget - boltLockLerp) * Math.min(1, dt * 10);
  const boltLockTilt = boltLockLerp * 0.15;   // slight upward tilt
  const boltLockSlide = boltLockLerp * 0.008;  // bolt slides back

  // ── ADS interpolation ──
  const adsTarget = gameState.isADS ? 1 : 0;
  gameState.adsAmount = gameState.adsAmount ?? 0;
  gameState.adsAmount += (adsTarget - gameState.adsAmount) * Math.min(1, dt * 12);

  const adsLayout = ADS_LAYOUTS[currentWeaponId] ?? layout;
  const adsLerp = gameState.adsAmount;

  const finalPosX = THREE.MathUtils.lerp(layout.pos[0], adsLayout.pos[0] ?? 0, adsLerp);
  const finalPosY = THREE.MathUtils.lerp(layout.pos[1], adsLayout.pos[1] ?? -0.05, adsLerp);
  const finalPosZ = THREE.MathUtils.lerp(layout.pos[2], adsLayout.pos[2] ?? -0.30, adsLerp);

  // ── ADS breathing sway (subtle figure-8, enhanced for sniper) ──
  const isSniper = currentWeaponId === 'sniper_rifle';
  const breathSpeed = isSniper ? 0.9 : 1.4;
  let breathAmpX = isSniper ? 0.0025 : 0.0008;
  let breathAmpY = isSniper ? 0.0018 : 0.0005;
  // Breath-hold: hold shift while ADS with sniper to steady the scope
  if (isSniper && gameState.isADS && gameState.keys.shift) {
    breathAmpX *= 0.1;
    breathAmpY *= 0.1;
  }
  const breathPhase = gameState.worldElapsed * breathSpeed;
  const breathX = Math.sin(breathPhase) * breathAmpX * adsLerp;
  const breathY = Math.sin(breathPhase * 2.03) * breathAmpY * adsLerp;

  // ── Weapon inspect idle animation ──
  // Reset activity on any player action
  if (isMoving || isSprinting || pReloading || gameState.isADS) {
    lastActivityTime = gameState.worldElapsed;
    inspectPhase = 0;
  }
  const idleDuration = gameState.worldElapsed - lastActivityTime;
  let inspectRotY = 0;
  let inspectRotX = 0;
  let inspectOffY = 0;
  if (idleDuration > INSPECT_DELAY && !pDead && currentWeaponId !== 'unarmed') {
    if (inspectPhase === 0) inspectPhase = 0.001; // start
    inspectPhase = Math.min(4, inspectPhase + dt * 0.8);
    let t: number;
    if (inspectPhase < 1) {
      // Ease in
      t = inspectPhase;
    } else if (inspectPhase < 3) {
      // Hold
      t = 1;
    } else {
      // Ease out
      t = 1 - (inspectPhase - 3);
    }
    const ease = t * t * (3 - 2 * t); // smoothstep
    inspectRotY = ease * 0.7;
    inspectRotX = ease * 0.25;
    inspectOffY = ease * 0.02;
    // Reset cycle
    if (inspectPhase >= 4) inspectPhase = 0;
  }

  vmGroup.position.set(
    finalPosX + bobX * (1 - adsLerp) + swayX * (1 - adsLerp * 0.7) + sprintLerp * 0.04 + breathX,
    finalPosY + bobY * (1 - adsLerp) + swayY * (1 - adsLerp * 0.7) + recoilUp - switchDrop - reloadDrop + breathY + inspectOffY + boltLockSlide,
    finalPosZ + recoilZ + switchDrop * 0.5,
  );

  vmGroup.rotation.set(
    layout.rot[0] - recoilRot + reloadTilt + inspectRotX - boltLockTilt,
    layout.rot[1] + sprintLerp * 0.35 + inspectRotY,
    layout.rot[2] - sprintLerp * 0.25 + reloadLerp * 0.3,
  );

  const mOff = layout.muzzleOffset;
  vmMuzzleFlash.position.set(mOff[0], mOff[1], mOff[2]);
  vmMuzzleMesh.position.set(mOff[0], mOff[1], mOff[2]);
  vmMuzzleSprite.position.set(mOff[0], mOff[1], mOff[2]);

  const mOff2 = layout.muzzleOffsetSecondary;
  if (mOff2) {
    vmMuzzleFlash2.position.set(mOff2[0], mOff2[1], mOff2[2]);
    vmMuzzleMesh2.position.set(mOff2[0], mOff2[1], mOff2[2]);
    vmMuzzleSprite2.position.set(mOff2[0], mOff2[1], mOff2[2]);
  }

  if (Math.abs(gameState.recoilPitch) > 0.0001) {
    const apply = gameState.recoilPitch * Math.min(1, dt * 20);
    gameState.cameraPitch += apply;
    gameState.recoilPitch -= apply;
  }
  if (Math.abs(gameState.recoilYaw) > 0.0001) {
    const apply = gameState.recoilYaw * Math.min(1, dt * 20);
    gameState.cameraYaw += apply;
    gameState.recoilYaw -= apply;
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function renderViewmodel(): void {
  if (!vmScene || !vmCamera) return;
  if (vmGroup && !vmGroup.visible) return;
  const renderer = gameState.renderer;
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(vmScene, vmCamera);
  renderer.autoClear = true;
}

export function resizeViewmodel(): void {
  if (vmCamera) {
    vmCamera.aspect = innerWidth / innerHeight;
    vmCamera.updateProjectionMatrix();
  }
}
