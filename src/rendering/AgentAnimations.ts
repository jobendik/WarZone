import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { TDMAgent } from '@/entities/TDMAgent';

const BASE_URL = import.meta.env.BASE_URL;

const SWAT_MODEL_URL = `${BASE_URL}models/characters/swat/Swat.fbx`;
const SWAT_ANIM_BASE = `${BASE_URL}models/characters/swat/animations`;

const ENEMY_MODEL_URL = `${BASE_URL}models/characters/enemy/enemy.fbx`;
const ENEMY_ANIM_BASE = `${BASE_URL}models/characters/enemy/animations`;

const _animEuler = new THREE.Euler();
const _animHorizVel = new THREE.Vector3();
const _animForward = new THREE.Vector3();
const _animRight = new THREE.Vector3();

// Juster ved behov. 0.01 passer ofte bra for Mixamo FBX.
const CHARACTER_SCALE = 0.01;

const ANIM_FILES = {
  idle: 'idle.fbx',
  idleAiming: 'idle aiming.fbx',
  idleCrouching: 'idle crouching.fbx',
  idleCrouchingAiming: 'idle crouching aiming.fbx',

  walkForward: 'walk forward.fbx',
  walkBackward: 'walk backward.fbx',
  walkLeft: 'walk left.fbx',
  walkRight: 'walk right.fbx',
  walkForwardLeft: 'walk forward left.fbx',
  walkForwardRight: 'walk forward right.fbx',
  walkBackwardLeft: 'walk backward left.fbx',
  walkBackwardRight: 'walk backward right.fbx',

  runForward: 'run forward.fbx',
  runBackward: 'run backward.fbx',
  runLeft: 'run left.fbx',
  runRight: 'run right.fbx',
  runForwardLeft: 'run forward left.fbx',
  runForwardRight: 'run forward right.fbx',
  runBackwardLeft: 'run backward left.fbx',
  runBackwardRight: 'run backward right.fbx',

  sprintForward: 'sprint forward.fbx',
  sprintBackward: 'sprint backward.fbx',
  sprintLeft: 'sprint left.fbx',
  sprintRight: 'sprint right.fbx',
  sprintForwardLeft: 'sprint forward left.fbx',
  sprintForwardRight: 'sprint forward right.fbx',
  sprintBackwardLeft: 'sprint backward left.fbx',
  sprintBackwardRight: 'sprint backward right.fbx',

  crouchWalkForward: 'walk crouching forward.fbx',
  crouchWalkBackward: 'walk crouching backward.fbx',
  crouchWalkLeft: 'walk crouching left.fbx',
  crouchWalkRight: 'walk crouching right.fbx',
  crouchWalkForwardLeft: 'walk crouching forward left.fbx',
  crouchWalkForwardRight: 'walk crouching forward right.fbx',
  crouchWalkBackwardLeft: 'walk crouching backward left.fbx',
  crouchWalkBackwardRight: 'walk crouching backward right.fbx',

  jumpUp: 'jump up.fbx',
  jumpLoop: 'jump loop.fbx',
  jumpDown: 'jump down.fbx',

  turnLeft90: 'turn 90 left.fbx',
  turnRight90: 'turn 90 right.fbx',
  crouchTurnLeft90: 'crouching turn 90 left.fbx',
  crouchTurnRight90: 'crouching turn 90 right.fbx',

  deathFront: 'death from the front.fbx',
  deathBack: 'death from the back.fbx',
  deathRight: 'death from right.fbx',
  deathFrontHeadshot: 'death from front headshot.fbx',
  deathBackHeadshot: 'death from back headshot.fbx',
  deathCrouchHeadshotFront: 'death crouching headshot front.fbx',
} as const;

type AgentAnimKey = keyof typeof ANIM_FILES;
type CharacterVariant = 'swat' | 'enemy';

type AgentAnimController = {
  mixer: THREE.AnimationMixer;
  model: THREE.Group;
  actions: Partial<Record<AgentAnimKey, THREE.AnimationAction>>;
  current: AgentAnimKey | null;
  elapsed: number;
  lockedUntil: number;
  dead: boolean;
  lastYaw: number;
  variant: CharacterVariant;
};

type CharacterAssetBundle = {
  modelUrl: string;
  animBase: string;
  baseModel: THREE.Group | null;
  loadPromise: Promise<void> | null;
  ready: boolean;
  clips: Partial<Record<AgentAnimKey, THREE.AnimationClip>>;
  clonePool: THREE.Group[];
};

const PREWARMED_CLONE_POOL_SIZE: Record<CharacterVariant, number> = {
  swat: 8,
  enemy: 9,
};

const loader = new FBXLoader();

const bundles: Record<CharacterVariant, CharacterAssetBundle> = {
  swat: {
    modelUrl: SWAT_MODEL_URL,
    animBase: SWAT_ANIM_BASE,
    baseModel: null,
    loadPromise: null,
    ready: false,
    clips: {},
    clonePool: [],
  },
  enemy: {
    modelUrl: ENEMY_MODEL_URL,
    animBase: ENEMY_ANIM_BASE,
    baseModel: null,
    loadPromise: null,
    ready: false,
    clips: {},
    clonePool: [],
  },
};

function loadFBX(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (obj) => resolve(obj as THREE.Group),
      undefined,
      (err) => reject(err),
    );
  });
}

function getFirstClip(obj: THREE.Group, url: string): THREE.AnimationClip {
  const clip = obj.animations?.[0];
  if (!clip) {
    throw new Error(`No animation clip found in ${url}`);
  }
  return clip;
}

function prepRenderable(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as any).isMesh) {
      // PERF: skinned-mesh shadow casting is *catastrophic* — the sun's
      // shadow pass would rasterise 11 deformed characters × multiple
      // submeshes every frame at 1024². On integrated GPUs this drops
      // framerate by >50% during combat. Ground/wall shadows from the
      // static arena geometry are plenty for readability.
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      // PERF: the previous loader forced `transparent = true` on every
      // bot material. That disables early-Z, breaks opaque batching, and
      // forces an alpha-sort pass per frame — combined with 11 bots each
      // having several submeshes, it was the biggest GPU stall during
      // firefights. Bot materials are fully opaque; leaving the flag off
      // restores the opaque fast path.
    }
  });
}

function isRootMotionPositionTrack(trackName: string): boolean {
  const n = trackName.toLowerCase();

  if (!n.endsWith('.position')) return false;

  return (
    n.includes('mixamorighips.position') ||
    n.includes('hips.position') ||
    n.includes('pelvis.position') ||
    n.includes('root.position') ||
    n.includes('armature.position') ||
    // Some Mixamo death clips put root drift on a top-level skeleton
    // root node ("spine" or the FBX-exported scene root). Catch any
    // track that starts with a plausible root bone name.
    /^mixamorig:?hips\.position$/.test(n) ||
    /^(hips|pelvis|root|armature|bip\d+|bone|spine)\.position$/.test(n)
  );
}

function makeClipInPlace(original: THREE.AnimationClip): THREE.AnimationClip {
  const clip = original.clone();

  // Apply in-place stripping to every clip we use on agents. The only
  // motion we ever want the animation itself to drive is vertical (Y —
  // jumps and the player-falls-on-death sink). Horizontal world motion
  // is handled by the entity's physics / AI — never by the clip. This
  // prevents mixamo death clips from sliding the corpse several metres
  // across the ground when they contain baked X/Z hip drift.
  clip.tracks = clip.tracks.map((track) => {
    if (!(track instanceof THREE.VectorKeyframeTrack)) {
      return track;
    }

    if (!isRootMotionPositionTrack(track.name)) {
      return track;
    }

    const values = track.values.slice();
    const baseX = values[0] ?? 0;
    const baseZ = values[2] ?? 0;

    for (let i = 0; i < values.length; i += 3) {
      values[i] = baseX;
      values[i + 2] = baseZ;
      // Y beholdes
    }

    return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
  });

  return clip;
}

function animUrl(variant: CharacterVariant, key: AgentAnimKey): string {
  return `${bundles[variant].animBase}/${ANIM_FILES[key]}`;
}

async function preloadCharacterAssets(variant: CharacterVariant): Promise<void> {
  const bundle = bundles[variant];
  if (bundle.ready) return;
  if (bundle.loadPromise) return bundle.loadPromise;

  bundle.loadPromise = (async () => {
    const keys = Object.keys(ANIM_FILES) as AgentAnimKey[];

    const [modelObj, ...animObjs] = await Promise.all([
      loadFBX(bundle.modelUrl),
      ...keys.map((key) => loadFBX(animUrl(variant, key))),
    ]);

    bundle.baseModel = modelObj;
    prepRenderable(bundle.baseModel);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const rawClip = getFirstClip(animObjs[i], animUrl(variant, key));
      bundle.clips[key] = makeClipInPlace(rawClip);
    }

    bundle.clonePool = [];
    for (let i = 0; i < PREWARMED_CLONE_POOL_SIZE[variant]; i++) {
      bundle.clonePool.push(makeCharacterClone(variant));
    }

    bundle.ready = true;
    console.info(`[AgentAnimations] ${variant} model + clips loaded.`);
  })();

  return bundle.loadPromise;
}

export async function preloadBlueSwatAssets(): Promise<void> {
  await preloadCharacterAssets('swat');
}

export async function preloadEnemyAssets(): Promise<void> {
  await preloadCharacterAssets('enemy');
}

export function hasBlueSwatAssets(): boolean {
  return bundles.swat.ready && !!bundles.swat.baseModel;
}

export function hasEnemyAssets(): boolean {
  return bundles.enemy.ready && !!bundles.enemy.baseModel;
}

function setRepeat(action: THREE.AnimationAction): void {
  action.enabled = true;
  action.clampWhenFinished = false;
  action.setLoop(THREE.LoopRepeat, Infinity);
}

function setOnce(action: THREE.AnimationAction): void {
  action.enabled = true;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
}

function buildController(model: THREE.Group, variant: CharacterVariant): AgentAnimController {
  const mixer = new THREE.AnimationMixer(model);
  const actions: Partial<Record<AgentAnimKey, THREE.AnimationAction>> = {};
  const bundle = bundles[variant];

  for (const key of Object.keys(bundle.clips) as AgentAnimKey[]) {
    const clip = bundle.clips[key];
    if (!clip) continue;

    const action = mixer.clipAction(clip);
    setRepeat(action);
    action.weight = 1;
    actions[key] = action;
  }

  return {
    mixer,
    model,
    actions,
    current: null,
    elapsed: 0,
    lockedUntil: 0,
    dead: false,
    lastYaw: 0,
    variant,
  };
}

function fallbackCandidates(key: AgentAnimKey): AgentAnimKey[] {
  const map: Partial<Record<AgentAnimKey, AgentAnimKey[]>> = {
    idleAiming: ['idle'],
    idleCrouchingAiming: ['idleCrouching', 'idleAiming', 'idle'],

    walkForwardLeft: ['walkForward', 'walkLeft'],
    walkForwardRight: ['walkForward', 'walkRight'],
    walkBackwardLeft: ['walkBackward', 'walkLeft'],
    walkBackwardRight: ['walkBackward', 'walkRight'],

    runForwardLeft: ['runForward', 'runLeft', 'walkForwardLeft'],
    runForwardRight: ['runForward', 'runRight', 'walkForwardRight'],
    runBackwardLeft: ['runBackward', 'runLeft', 'walkBackwardLeft'],
    runBackwardRight: ['runBackward', 'runRight', 'walkBackwardRight'],

    sprintForwardLeft: ['sprintForward', 'runForwardLeft', 'runForward'],
    sprintForwardRight: ['sprintForward', 'runForwardRight', 'runForward'],
    sprintBackwardLeft: ['sprintBackward', 'runBackwardLeft', 'runBackward'],
    sprintBackwardRight: ['sprintBackward', 'runBackwardRight', 'runBackward'],
    sprintLeft: ['runLeft'],
    sprintRight: ['runRight'],
    sprintForward: ['runForward'],
    sprintBackward: ['runBackward'],

    crouchWalkForwardLeft: ['crouchWalkForward', 'crouchWalkLeft', 'walkForwardLeft'],
    crouchWalkForwardRight: ['crouchWalkForward', 'crouchWalkRight', 'walkForwardRight'],
    crouchWalkBackwardLeft: ['crouchWalkBackward', 'crouchWalkLeft', 'walkBackwardLeft'],
    crouchWalkBackwardRight: ['crouchWalkBackward', 'crouchWalkRight', 'walkBackwardRight'],
    crouchWalkForward: ['walkForward'],
    crouchWalkBackward: ['walkBackward'],
    crouchWalkLeft: ['walkLeft'],
    crouchWalkRight: ['walkRight'],

    jumpLoop: ['jumpUp'],
    jumpDown: ['jumpLoop', 'jumpUp'],

    turnLeft90: ['idle'],
    turnRight90: ['idle'],
    crouchTurnLeft90: ['idleCrouchingAiming', 'idleCrouching'],
    crouchTurnRight90: ['idleCrouchingAiming', 'idleCrouching'],

    deathFrontHeadshot: ['deathFront'],
    deathBackHeadshot: ['deathBack'],
    deathCrouchHeadshotFront: ['deathFront'],
    deathRight: ['deathFront'],
  };

  return [key, ...(map[key] ?? [])];
}

function resolveExistingKey(
  actions: Partial<Record<AgentAnimKey, THREE.AnimationAction>>,
  key: AgentAnimKey,
): AgentAnimKey | null {
  const candidates = fallbackCandidates(key);
  for (const candidate of candidates) {
    if (actions[candidate]) return candidate;
  }
  return null;
}

function fadeTo(ctrl: AgentAnimController, requested: AgentAnimKey, fade = 0.16): void {
  const key = resolveExistingKey(ctrl.actions, requested);
  if (!key) return;
  if (ctrl.current === key) return;

  const next = ctrl.actions[key];
  if (!next) return;

  const prev = ctrl.current ? ctrl.actions[ctrl.current] : null;
  if (prev) prev.fadeOut(fade);

  setRepeat(next);
  next.reset().fadeIn(fade).play();
  ctrl.current = key;
}

function playOneShot(ctrl: AgentAnimController, requested: AgentAnimKey, lockSeconds: number): number {
  const key = resolveExistingKey(ctrl.actions, requested);
  if (!key) return 0;

  const next = ctrl.actions[key];
  if (!next) return 0;

  const prev = ctrl.current ? ctrl.actions[ctrl.current] : null;
  if (prev && prev !== next) prev.fadeOut(0.08);

  setOnce(next);
  next.reset().fadeIn(0.08).play();

  ctrl.current = key;
  ctrl.lockedUntil = ctrl.elapsed + lockSeconds;

  return next.getClip().duration || lockSeconds;
}

function getController(renderComponent: THREE.Object3D | null | undefined): AgentAnimController | null {
  if (!renderComponent) return null;
  return (renderComponent.userData.agentAnimController as AgentAnimController | undefined) ?? null;
}

function normalizeAngle(rad: number): number {
  while (rad > Math.PI) rad -= Math.PI * 2;
  while (rad < -Math.PI) rad += Math.PI * 2;
  return rad;
}

function yawFromQuaternion(q: THREE.Quaternion): number {
  const e = _animEuler.setFromQuaternion(q, 'YXZ');
  return e.y;
}

function pickDirectionalSet(
  forward: number,
  right: number,
  prefix: 'walk' | 'run' | 'sprint' | 'crouchWalk',
): AgentAnimKey {
  const f = Math.abs(forward) < 0.2 ? 0 : (forward > 0 ? 1 : -1);
  const r = Math.abs(right) < 0.2 ? 0 : (right > 0 ? 1 : -1);

  if (f === 0 && r === 0) return `${prefix}Forward` as AgentAnimKey;

  if (prefix === 'crouchWalk') {
    if (f === 1 && r === -1) return 'crouchWalkForwardLeft';
    if (f === 1 && r === 1) return 'crouchWalkForwardRight';
    if (f === -1 && r === -1) return 'crouchWalkBackwardLeft';
    if (f === -1 && r === 1) return 'crouchWalkBackwardRight';
    if (f === 1) return 'crouchWalkForward';
    if (f === -1) return 'crouchWalkBackward';
    if (r === -1) return 'crouchWalkLeft';
    return 'crouchWalkRight';
  }

  if (prefix === 'walk') {
    if (f === 1 && r === -1) return 'walkForwardLeft';
    if (f === 1 && r === 1) return 'walkForwardRight';
    if (f === -1 && r === -1) return 'walkBackwardLeft';
    if (f === -1 && r === 1) return 'walkBackwardRight';
    if (f === 1) return 'walkForward';
    if (f === -1) return 'walkBackward';
    if (r === -1) return 'walkLeft';
    return 'walkRight';
  }

  if (prefix === 'run') {
    if (f === 1 && r === -1) return 'runForwardLeft';
    if (f === 1 && r === 1) return 'runForwardRight';
    if (f === -1 && r === -1) return 'runBackwardLeft';
    if (f === -1 && r === 1) return 'runBackwardRight';
    if (f === 1) return 'runForward';
    if (f === -1) return 'runBackward';
    if (r === -1) return 'runLeft';
    return 'runRight';
  }

  if (f === 1 && r === -1) return 'sprintForwardLeft';
  if (f === 1 && r === 1) return 'sprintForwardRight';
  if (f === -1 && r === -1) return 'sprintBackwardLeft';
  if (f === -1 && r === 1) return 'sprintBackwardRight';
  if (f === 1) return 'sprintForward';
  if (f === -1) return 'sprintBackward';
  if (r === -1) return 'sprintLeft';
  return 'sprintRight';
}

function chooseMovementAnimation(
  ag: TDMAgent,
  speed: number,
  localForward: number,
  localRight: number,
): AgentAnimKey {
  const stationary = speed < 0.12;
  const crouched = ag.stateName === 'COVER' || ag.stateName === 'PEEK';
  const combat = ag.stateName === 'ENGAGE' || ag.stateName === 'TEAM_PUSH' || ag.stateName === 'FLANK';
  const sprinting = ag.stateName === 'RETREAT' || ag.stateName === 'TEAM_PUSH' || speed > ag.maxSpeed * 0.8;
  const patrolling = ag.stateName === 'PATROL' || ag.stateName === 'INVESTIGATE';

  if (Math.abs(ag.velocity.y) > 0.75) {
    return ag.velocity.y > 0 ? 'jumpUp' : 'jumpDown';
  }

  if (crouched) {
    if (stationary) {
      return ag.currentTarget ? 'idleCrouchingAiming' : 'idleCrouching';
    }
    return pickDirectionalSet(localForward, localRight, 'crouchWalk');
  }

  if (stationary) {
    return ag.currentTarget ? 'idleAiming' : 'idle';
  }

  if (sprinting) {
    return pickDirectionalSet(localForward, localRight, 'sprint');
  }

  if (combat) {
    return pickDirectionalSet(localForward, localRight, 'run');
  }

  if (patrolling && speed < ag.maxSpeed * 0.45) {
    return pickDirectionalSet(localForward, localRight, 'walk');
  }

  return pickDirectionalSet(localForward, localRight, 'run');
}

function attachCharacter(renderComponent: THREE.Group, variant: CharacterVariant): void {
  const bundle = bundles[variant];
  if (!bundle.baseModel || !bundle.ready) {
    throw new Error(`${variant} assets not preloaded.`);
  }

  const model = borrowCharacterClone(variant);
  model.name = variant === 'swat' ? 'BlueSwatCharacter' : 'EnemyCharacter';
  model.position.set(0, 0, 0);

  renderComponent.add(model);

  const ctrl = buildController(model, variant);
  ctrl.lastYaw = yawFromQuaternion(renderComponent.quaternion);

  renderComponent.userData.characterModel = model;
  renderComponent.userData.agentAnimController = ctrl;

  fadeTo(ctrl, 'idle', 0.01);
}

export function attachBlueSwatCharacter(renderComponent: THREE.Group): void {
  attachCharacter(renderComponent, 'swat');
}

export function attachEnemyCharacter(renderComponent: THREE.Group): void {
  attachCharacter(renderComponent, 'enemy');
}

export function createBlueSwatWarmupClone(): THREE.Group | null {
  const bundle = bundles.swat;
  if (!bundle.baseModel || !bundle.ready) return null;
  const model = makeCharacterClone('swat');
  model.name = 'BlueSwatWarmup';
  return model;
}

export function createEnemyWarmupClone(): THREE.Group | null {
  const bundle = bundles.enemy;
  if (!bundle.baseModel || !bundle.ready) return null;
  const model = makeCharacterClone('enemy');
  model.name = 'EnemyWarmup';
  return model;
}

function makeCharacterClone(variant: CharacterVariant): THREE.Group {
  const bundle = bundles[variant];
  if (!bundle.baseModel) {
    throw new Error(`${variant} base model not loaded.`);
  }

  const model = skeletonClone(bundle.baseModel) as THREE.Group;
  model.scale.setScalar(CHARACTER_SCALE);
  prepRenderable(model);
  return model;
}

function borrowCharacterClone(variant: CharacterVariant): THREE.Group {
  const bundle = bundles[variant];
  const model = bundle.clonePool.pop();
  return model ?? makeCharacterClone(variant);
}

export function updateAgentAnimations(agents: readonly TDMAgent[], dt: number): void {
  for (const ag of agents) {
    const ctrl = getController(ag.renderComponent);
    if (!ctrl) continue;

    ctrl.elapsed += dt;
    ctrl.mixer.update(dt);

    // Ekstra sikkerhet mot root motion på modellnivå
    ctrl.model.position.x = 0;
    ctrl.model.position.z = 0;

    if (ctrl.dead) continue;
    if (ctrl.elapsed < ctrl.lockedUntil) continue;

    const rc = ag.renderComponent!;
    const yaw = yawFromQuaternion(rc.quaternion);
    const yawDelta = normalizeAngle(yaw - ctrl.lastYaw);
    ctrl.lastYaw = yaw;

    const horizVel = _animHorizVel.set(ag.velocity.x, 0, ag.velocity.z);
    const speed = horizVel.length();

    const stationary = speed < 0.08;
    const turningHard = stationary && Math.abs(yawDelta) > THREE.MathUtils.degToRad(0.9);

    if (turningHard) {
      const crouched = ag.stateName === 'COVER' || ag.stateName === 'PEEK';
      const turnKey = yawDelta > 0
        ? (crouched ? 'crouchTurnLeft90' : 'turnLeft90')
        : (crouched ? 'crouchTurnRight90' : 'turnRight90');

      const resolvedTurn = resolveExistingKey(ctrl.actions, turnKey);
      if (resolvedTurn && resolvedTurn !== 'idle' && resolvedTurn !== 'idleCrouching') {
        playOneShot(ctrl, turnKey, 0.22);
        return;
      }
    }

    const q = rc.quaternion;
    const forward = _animForward.set(0, 0, 1).applyQuaternion(q).normalize();
    const right = _animRight.set(1, 0, 0).applyQuaternion(q).normalize();

    const localForward = horizVel.dot(forward);
    const localRight = horizVel.dot(right);

    const next = chooseMovementAnimation(ag, speed, localForward, localRight);
    fadeTo(ctrl, next, speed < 0.2 ? 0.18 : 0.12);
  }
}

export function playAgentDeathAnimation(renderComponent: THREE.Object3D | null | undefined): number {
  const ctrl = getController(renderComponent);
  if (!ctrl) return 0;

  ctrl.dead = true;

  const deathPool: AgentAnimKey[] = [
    'deathFront',
    'deathBack',
    'deathRight',
    'deathFrontHeadshot',
    'deathBackHeadshot',
    'deathCrouchHeadshotFront',
  ];

  const pick = deathPool[Math.floor(Math.random() * deathPool.length)];
  const duration = playOneShot(ctrl, pick, 1.25);

  return duration || 1.25;
}

export function resetAgentAnimation(renderComponent: THREE.Object3D | null | undefined): void {
  const ctrl = getController(renderComponent);
  if (!ctrl) return;

  ctrl.dead = false;
  ctrl.lockedUntil = 0;
  ctrl.elapsed = 0;
  fadeTo(ctrl, 'idle', 0.01);
}
