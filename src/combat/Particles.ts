import * as THREE from 'three';
import { gameState } from '@/core/GameState';

// ── Particle mesh pool ──
// Pre-allocate meshes to avoid GC spikes from frequent new THREE.Mesh() calls.
const POOL_SIZE = 128;
const BLOOD_POOL_SIZE = 96;
const BLOOD_DECAL_POOL_SIZE = 32;
const SHELL_POOL_SIZE = 40;
const SMOKE_PUFF_POOL_SIZE = 48;
const TRAIL_SMOKE_POOL_SIZE = 96;
const TRAIL_EMBER_POOL_SIZE = 96;
const RING_POOL_SIZE = 16;

interface PoolEntry { mesh: THREE.Mesh; inUse: boolean; }
const _impactPool: PoolEntry[] = [];
const _sparkPool: PoolEntry[] = [];
const _smokePuffPool: PoolEntry[] = [];
const _trailSmokePool: PoolEntry[] = [];
const _trailEmberPool: PoolEntry[] = [];
const _deathRingPool: PoolEntry[] = [];
const _shockRingPool: PoolEntry[] = [];
const _scorchPool: PoolEntry[] = [];
const _bloodPool: PoolEntry[] = [];
const _bloodDecalPool: PoolEntry[] = [];
const _shellPool: PoolEntry[] = [];

interface LightPoolEntry { light: THREE.PointLight; inUse: boolean; }
const _transientLightPool: LightPoolEntry[] = [];
const TRANSIENT_LIGHT_POOL_SIZE = 16;
let _transientLightsInited = false;

// Shared geometry/material for impact particles to avoid per-spawn allocations
const _impactGeo = new THREE.SphereGeometry(0.06, 4, 4);
const _sparkGeo = new THREE.SphereGeometry(0.03, 3, 3);
const _smokePuffGeo = new THREE.SphereGeometry(0.2, 5, 5);
const _impactMatCache = new Map<number, THREE.MeshBasicMaterial>();
const _sharedBasicMatCache = new Map<string, THREE.MeshBasicMaterial>();
const _deathRingGeo = new THREE.RingGeometry(0.1, 1.4, 24);
const _shockRingGeo = new THREE.RingGeometry(0.2, 0.5, 20);
const _scorchGeo = new THREE.RingGeometry(0.3, 1, 20);
const _bloodMat = getImpactMat(0x880000);
const _trailSmokeMat = getSharedBasicMat(0x666666, 0.45);
const _trailEmberMat = getSharedBasicMat(0xff6600, 0.9, true, THREE.FrontSide, false);
const _explosionSmokeMat = getSharedBasicMat(0x222222, 0.5);
const _shockRingMat = getSharedBasicMat(0xffffff, 0.4, true, THREE.DoubleSide, false);
const _bloodDecalMatShared = getSharedBasicMat(0x440000, 0.6, false, THREE.DoubleSide, false);

function getSharedBasicMat(
  col: number,
  opacity = 1,
  additive = false,
  side: THREE.Side = THREE.FrontSide,
  depthWrite = true,
): THREE.MeshBasicMaterial {
  const key = `${col}:${opacity}:${additive ? 1 : 0}:${side}:${depthWrite ? 1 : 0}`;
  let mat = _sharedBasicMatCache.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color: col,
      transparent: opacity < 1 || additive,
      opacity,
      side,
      depthWrite,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    _sharedBasicMatCache.set(key, mat);
  }
  return mat;
}

function getImpactMat(col: number): THREE.MeshBasicMaterial {
  let mat = _impactMatCache.get(col);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color: col, transparent: true });
    _impactMatCache.set(col, mat);
  }
  return mat;
}

/** Borrow a mesh from a pool, or create a new one if pool empty. */
function borrowMesh(pool: PoolEntry[], geo: THREE.BufferGeometry, mat: THREE.MeshBasicMaterial): THREE.Mesh {
  for (const entry of pool) {
    if (!entry.inUse) {
      entry.inUse = true;
      const m = entry.mesh;
      (m.material as THREE.MeshBasicMaterial).copy(mat);
      m.visible = true;
      m.scale.setScalar(1);
      m.rotation.set(0, 0, 0);
      return m;
    }
  }
  // Pool exhausted — create new mesh (will be collected normally)
  return new THREE.Mesh(geo, mat.clone());
}

/** Return a mesh to its pool. */
function returnMesh(pool: PoolEntry[], mesh: THREE.Mesh): boolean {
  for (const entry of pool) {
    if (entry.mesh === mesh) {
      entry.inUse = false;
      mesh.visible = false;
      return true;
    }
  }
  return false; // not from pool — scene.remove as before
}

function initTransientLightPool(): void {
  if (_transientLightsInited) return;
  _transientLightsInited = true;
  // PERF: DO NOT add the pooled lights to the scene here. Every light in
  // the scene (even with intensity=0) contributes to the fragment-shader
  // light loop on every PBR surface, which is the single largest GPU cost
  // in a firefight. We scene.add() on borrow and scene.remove() on return
  // so the active light count is ~0 outside combat and typically 1-3 at
  // peak (muzzle flash + impact flash). Shader variants are warmed by
  // attachCombatFXWarmupProxies() so the on-demand add does not stall.
  for (let i = 0; i < TRANSIENT_LIGHT_POOL_SIZE; i++) {
    const light = new THREE.PointLight(0xffaa55, 0, 8);
    light.castShadow = false;
    _transientLightPool.push({ light, inUse: false });
  }
}

function borrowTransientLight(col: number, intensity: number, distance: number): THREE.PointLight | undefined {
  initTransientLightPool();
  for (const entry of _transientLightPool) {
    if (entry.inUse) continue;
    entry.inUse = true;
    entry.light.color.setHex(col);
    entry.light.intensity = intensity;
    entry.light.distance = distance;
    if (!entry.light.parent) gameState.scene.add(entry.light);
    return entry.light;
  }
  return undefined;
}

function returnTransientLight(light: THREE.PointLight): boolean {
  for (const entry of _transientLightPool) {
    if (entry.light !== light) continue;
    entry.inUse = false;
    entry.light.intensity = 0;
    entry.light.distance = 0;
    if (entry.light.parent) entry.light.parent.remove(entry.light);
    return true;
  }
  return false;
}

let _combatFxWarmupGroup: THREE.Group | null = null;
let _combatFxWarmupLight: THREE.PointLight | null = null;

export function attachCombatFXWarmupProxies(): void {
  if (_combatFxWarmupGroup || !gameState.scene || !gameState.camera) return;
  initTransientLightPool();

  const cam = gameState.camera;
  const group = new THREE.Group();
  group.position.copy(cam.position);
  group.position.z -= 2.5;
  group.position.y += 1.5;

  const warmMeshes: Array<THREE.Mesh> = [
    new THREE.Mesh(_impactGeo, getSharedBasicMat(0xff6600, 1, true, THREE.FrontSide, false)),
    new THREE.Mesh(_smokePuffGeo, _explosionSmokeMat),
    new THREE.Mesh(_deathRingGeo, getSharedBasicMat(0xff6644, 0.8, false, THREE.DoubleSide, true)),
    new THREE.Mesh(_shockRingGeo, _shockRingMat),
    new THREE.Mesh(_bloodGeo, _bloodMat),
    new THREE.Mesh(_bloodDecalGeo, _bloodDecalMatShared),
    new THREE.Mesh(_scorchGeo, getSharedBasicMat(0xff6600, 0.7, true, THREE.DoubleSide, false)),
  ];

  warmMeshes.forEach((mesh, index) => {
    mesh.position.set((index - 3) * 0.18, 0, 0);
    group.add(mesh);
  });

  gameState.scene.add(group);
  _combatFxWarmupGroup = group;

  const light = borrowTransientLight(0xffaa55, 1.5, 10);
  if (light) {
    light.position.copy(group.position);
    _combatFxWarmupLight = light;
  }
}

export function detachCombatFXWarmupProxies(): void {
  if (_combatFxWarmupGroup) {
    gameState.scene.remove(_combatFxWarmupGroup);
    _combatFxWarmupGroup.clear();
    _combatFxWarmupGroup = null;
  }
  if (_combatFxWarmupLight) {
    returnTransientLight(_combatFxWarmupLight);
    _combatFxWarmupLight = null;
  }
}

function cleanupParticleVisual(p: typeof gameState.particles[number], scene: THREE.Scene): void {
  const tracerPool = (p as any)._tracerPool as TracerPool | undefined;
  if (tracerPool) {
    for (const e of tracerPool.entries) {
      if (e.mesh === p.mesh) {
        e.inUse = false;
        e.mesh.visible = false;
        break;
      }
    }
  } else if ((p as any)._pool) {
    if (!returnMesh((p as any)._pool, p.mesh)) {
      scene.remove(p.mesh);
      if (!p._sharedGeometry) p.mesh.geometry.dispose();
      if (!p._sharedMaterial) (p.mesh.material as THREE.Material).dispose();
    }
  } else {
    scene.remove(p.mesh);
    if (!p._sharedGeometry) p.mesh.geometry.dispose();
    if (!p._sharedMaterial) (p.mesh.material as THREE.Material).dispose();
  }

  if (p.light) {
    if (!returnTransientLight(p.light)) scene.remove(p.light);
  }
}

/** Initialize mesh pools. Call once after scene is ready. */
export function initParticlePools(): void {
  const defaultMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
  for (let i = 0; i < POOL_SIZE; i++) {
    const im = new THREE.Mesh(_impactGeo, defaultMat.clone());
    im.visible = false;
    gameState.scene.add(im);
    _impactPool.push({ mesh: im, inUse: false });

    const sm = new THREE.Mesh(_sparkGeo, defaultMat.clone());
    sm.visible = false;
    gameState.scene.add(sm);
    _sparkPool.push({ mesh: sm, inUse: false });
  }

  for (let i = 0; i < SMOKE_PUFF_POOL_SIZE; i++) {
    const puff = new THREE.Mesh(_smokePuffGeo, _explosionSmokeMat.clone());
    puff.visible = false;
    gameState.scene.add(puff);
    _smokePuffPool.push({ mesh: puff, inUse: false });
  }

  for (let i = 0; i < TRAIL_SMOKE_POOL_SIZE; i++) {
    const smoke = new THREE.Mesh(_smokeGeo, _trailSmokeMat.clone());
    smoke.visible = false;
    gameState.scene.add(smoke);
    _trailSmokePool.push({ mesh: smoke, inUse: false });
  }

  for (let i = 0; i < TRAIL_EMBER_POOL_SIZE; i++) {
    const ember = new THREE.Mesh(_trailEmberGeo, _trailEmberMat.clone());
    ember.visible = false;
    gameState.scene.add(ember);
    _trailEmberPool.push({ mesh: ember, inUse: false });
  }

  for (let i = 0; i < RING_POOL_SIZE; i++) {
    const deathRing = new THREE.Mesh(_deathRingGeo, defaultMat.clone());
    deathRing.visible = false;
    gameState.scene.add(deathRing);
    _deathRingPool.push({ mesh: deathRing, inUse: false });

    const shockRing = new THREE.Mesh(_shockRingGeo, defaultMat.clone());
    shockRing.visible = false;
    gameState.scene.add(shockRing);
    _shockRingPool.push({ mesh: shockRing, inUse: false });

    const scorch = new THREE.Mesh(_scorchGeo, defaultMat.clone());
    scorch.visible = false;
    gameState.scene.add(scorch);
    _scorchPool.push({ mesh: scorch, inUse: false });
  }

  for (let i = 0; i < BLOOD_POOL_SIZE; i++) {
    const blood = new THREE.Mesh(_bloodGeo, _bloodMat.clone());
    blood.visible = false;
    gameState.scene.add(blood);
    _bloodPool.push({ mesh: blood, inUse: false });
  }

  for (let i = 0; i < BLOOD_DECAL_POOL_SIZE; i++) {
    const decal = new THREE.Mesh(_bloodDecalGeo, _bloodDecalMat.clone());
    decal.visible = false;
    gameState.scene.add(decal);
    _bloodDecalPool.push({ mesh: decal, inUse: false });
  }

  for (let i = 0; i < SHELL_POOL_SIZE; i++) {
    const shell = new THREE.Mesh(_shellGeo, _shellMat.clone());
    shell.visible = false;
    gameState.scene.add(shell);
    _shellPool.push({ mesh: shell, inUse: false });
  }

  initBulletHolePool();

  // PERF: eagerly build tracer + muzzle pools here (they were previously
  // lazily initialized on first shot, which caused a ~50-150ms stall at
  // the exact moment combat started). Pre-warming the cached material
  // variants used by AI teams also compiles their shader variants now
  // rather than mid-firefight.
  initTransientLightPool();
  initTracerPools();
  initMuzzlePool();

  // Warm common tracer & muzzle-flash colors so shader variants are
  // compiled during load, not when the first shot fires.
  getTracerGlowMat(0xffddaa);
  getTracerGlowMat(0xff4444);
  getTracerGlowMat(0x44aaff);
  getImpactMat(0xffaa44);
  getImpactMat(0xaaaaaa);
  getImpactMat(0x880000);
  getSharedBasicMat(0xff6600, 1, true, THREE.FrontSide, false);
  getSharedBasicMat(0xff6644, 0.8, false, THREE.DoubleSide, true);
  getSharedBasicMat(0xff6600, 0.7, true, THREE.DoubleSide, false);
}

const _camDistScratch = new THREE.Vector3();
function camDistSq(pos: THREE.Vector3): number {
  const cam = gameState.camera;
  if (!cam) return 0;
  _camDistScratch.subVectors(pos, cam.position);
  return _camDistScratch.lengthSq();
}

/**
 * Spawn impact particles at a position.
 *
 * PERF: impacts > 70m from the camera are invisible at typical FOV and
 * resolution. Skip spawning them entirely.
 */
export function spawnImpact(pos: THREE.Vector3, col: number, n = 6): void {
  if (camDistSq(pos) > 70 * 70) return;
  const baseMat = getImpactMat(col);
  for (let i = 0; i < n; i++) {
    const m = borrowMesh(_impactPool, _impactGeo, baseMat);
    if (!m.parent) gameState.scene.add(m);
    m.position.copy(pos);
    gameState.particles.push({
      mesh: m,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        Math.random() * 3 + 1,
        (Math.random() - 0.5) * 6,
      ),
      life: 0.4,
      mL: 0.4,
      _pool: _impactPool,
    });
  }
}

/**
 * Spawn wall hit sparks — brighter, faster, more directional.
 * Surface type controls color palette.
 */
export function spawnWallSparks(pos: THREE.Vector3, normal: THREE.Vector3 | null, n = 8, surface: 'metal' | 'wood' | 'concrete' = 'concrete'): void {
  if (camDistSq(pos) > 70 * 70) return;
  const palettes = {
    metal:    { bright: 0xffeebb, dim: 0x8899aa },
    wood:     { bright: 0xcc9944, dim: 0x664422 },
    concrete: { bright: 0xffcc66, dim: 0x556688 },
  };
  const pal = palettes[surface];
  const sparkMat = getImpactMat(pal.bright);
  const dimMat = getImpactMat(pal.dim);
  for (let i = 0; i < n; i++) {
    const isBright = i < n * 0.6;
    const m = borrowMesh(_sparkPool, _sparkGeo, isBright ? sparkMat : dimMat);
    if (!m.parent) gameState.scene.add(m);
    m.position.copy(pos);
    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 8,
      Math.random() * 4 + 2,
      (Math.random() - 0.5) * 8,
    );
    // Bias sparks along the wall normal for directionality
    if (normal) {
      vel.x += normal.x * 3;
      vel.y += normal.y * 3;
      vel.z += normal.z * 3;
    }
    gameState.particles.push({
      mesh: m, vel,
      life: 0.15 + Math.random() * 0.2,
      mL: 0.35,
      _pool: _sparkPool,
    });
  }
}

// ═══════════════════════════════════════════
//  SHELL CASINGS
// ═══════════════════════════════════════════
const _shellGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.03, 4, 1);
const _shellMat = new THREE.MeshBasicMaterial({ color: 0xccaa44 });

/**
 * Spawn a shell casing particle ejected to the right of the camera.
 */
export function spawnShellCasing(origin: THREE.Vector3, rightDir: THREE.Vector3): void {
  const m = borrowMesh(_shellPool, _shellGeo, _shellMat);
  m.position.copy(origin);
  m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  gameState.particles.push({
    mesh: m,
    vel: new THREE.Vector3(
      rightDir.x * 3 + (Math.random() - 0.5) * 1.5,
      2 + Math.random() * 2,
      rightDir.z * 3 + (Math.random() - 0.5) * 1.5,
    ),
    life: 0.6 + Math.random() * 0.3,
    mL: 0.9,
    _pool: _shellPool,
    _sharedGeometry: true,
  });
}

/**
 * Spawn a hitscan tracer line from origin to end point.
 */
/**
 * Spawn a hitscan tracer line from origin to end point.
 *
 * PERF: tracers are by far the most frequent per-frame scene allocation in
 * combat — a 5v5 firefight can produce 100+ shots/sec. To keep GC/GPU cost
 * bounded we:
 *   1. Cull shots that aren't visible from the camera (distance + frustum)
 *   2. Pool the two short-lived Cylinder meshes through a ring buffer with
 *      a fixed shared geometry (scaled to tracer length via mesh.scale.y)
 *   3. Share a single material per tracer colour (held in a small cache)
 *
 * The visual is identical to the original but the per-shot cost drops from
 * ~4 allocations + 4 disposes to zero allocations after warmup.
 */
const _tracerGlowGeo = new THREE.CylinderGeometry(0.028, 0.020, 1, 4, 1);
const _tracerCoreGeo = new THREE.CylinderGeometry(0.010, 0.008, 1, 5, 1);
const _tracerCoreMat = new THREE.MeshBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0.95,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const _tracerGlowMatCache = new Map<number, THREE.MeshBasicMaterial>();
function getTracerGlowMat(col: number): THREE.MeshBasicMaterial {
  let m = _tracerGlowMatCache.get(col);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    _tracerGlowMatCache.set(col, m);
  }
  return m;
}

interface TracerPool { entries: { mesh: THREE.Mesh; inUse: boolean }[]; }
const TRACER_POOL_SIZE = 96;
const _tracerGlowPool: TracerPool = { entries: [] };
const _tracerCorePool: TracerPool = { entries: [] };
let _tracerPoolsInited = false;

function initTracerPools(): void {
  if (_tracerPoolsInited) return;
  _tracerPoolsInited = true;
  for (let i = 0; i < TRACER_POOL_SIZE; i++) {
    const glow = new THREE.Mesh(_tracerGlowGeo, _tracerCoreMat);
    glow.visible = false; glow.frustumCulled = true;
    gameState.scene.add(glow);
    _tracerGlowPool.entries.push({ mesh: glow, inUse: false });

    const core = new THREE.Mesh(_tracerCoreGeo, _tracerCoreMat);
    core.visible = false; core.frustumCulled = true;
    gameState.scene.add(core);
    _tracerCorePool.entries.push({ mesh: core, inUse: false });
  }
}

function borrowTracer(pool: TracerPool): THREE.Mesh | null {
  for (const e of pool.entries) {
    if (!e.inUse) { e.inUse = true; e.mesh.visible = true; return e.mesh; }
  }
  return null; // pool exhausted — skip this tracer rather than allocate
}

// Reused temporaries
const _tracerDir = new THREE.Vector3();
const _tracerMid = new THREE.Vector3();
const _tracerCamDelta = new THREE.Vector3();

export function spawnTracer(origin: THREE.Vector3, end: THREE.Vector3, col: number): void {
  _tracerDir.subVectors(end, origin);
  const len = _tracerDir.length();
  if (len < 0.5) return;

  // Camera-distance cull — tracers outside ~80m from camera or behind it
  // aren't worth the draw cost. Player's own shots always render.
  const cam = gameState.camera;
  if (cam) {
    _tracerMid.addVectors(origin, end).multiplyScalar(0.5);
    _tracerCamDelta.subVectors(_tracerMid, cam.position);
    const camDistSq = _tracerCamDelta.lengthSq();
    if (camDistSq > 80 * 80) return;
  } else {
    _tracerMid.addVectors(origin, end).multiplyScalar(0.5);
  }

  initTracerPools();

  const glowMat = getTracerGlowMat(col);
  const glow = borrowTracer(_tracerGlowPool);
  if (glow) {
    glow.material = glowMat;
    glow.position.copy(_tracerMid);
    glow.scale.set(1, len, 1);
    glow.lookAt(end);
    glow.rotateX(Math.PI / 2);
    gameState.particles.push({ mesh: glow, vel: new THREE.Vector3(), life: 0.07, mL: 0.07, _tracerPool: _tracerGlowPool } as any);
  }

  const core = borrowTracer(_tracerCorePool);
  if (core) {
    core.material = _tracerCoreMat;
    core.position.copy(_tracerMid);
    core.scale.set(1, len, 1);
    core.lookAt(end);
    core.rotateX(Math.PI / 2);
    gameState.particles.push({ mesh: core, vel: new THREE.Vector3(), life: 0.05, mL: 0.05, _tracerPool: _tracerCorePool } as any);
  }
}

/**
 * Spawn a muzzle flash light at a world position (for AI agents shooting).
 *
 * PERF: previously created a new PointLight + SphereGeometry + Material per
 * shot. With 5+ bots firing at 8-12 rounds/sec that meant hundreds of
 * short-lived lights per second — each forcing material-shader cost on every
 * shadow-receiving mesh and dozens of allocations/disposes. We now pool the
 * flash sphere, share a single material, and drop the PointLight entirely
 * for AI shots that aren't close to the camera (the sphere still conveys the
 * flash visually; point-lights only add noticeably when you can see the wash
 * on surfaces).
 */
const _muzzleGeo = new THREE.SphereGeometry(0.08, 6, 6);
const _muzzleMat = new THREE.MeshBasicMaterial({
  color: 0xffdd55, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const _muzzlePool: TracerPool = { entries: [] };
let _muzzlePoolInited = false;
function initMuzzlePool(): void {
  if (_muzzlePoolInited) return;
  _muzzlePoolInited = true;
  for (let i = 0; i < 64; i++) {
    const m = new THREE.Mesh(_muzzleGeo, _muzzleMat);
    m.visible = false; m.frustumCulled = true;
    gameState.scene.add(m);
    _muzzlePool.entries.push({ mesh: m, inUse: false });
  }
}

const _muzzleCamDelta = new THREE.Vector3();

export function spawnMuzzleFlash(pos: THREE.Vector3, col: number): void {
  const cam = gameState.camera;
  let camDistSq = 0;
  if (cam) {
    _muzzleCamDelta.subVectors(pos, cam.position);
    camDistSq = _muzzleCamDelta.lengthSq();
    // Far-away flashes aren't worth any cost — you can't see them.
    if (camDistSq > 90 * 90) return;
  }

  initMuzzlePool();
  const sphere = borrowTracer(_muzzlePool);
  if (!sphere) return;
  sphere.position.copy(pos);

  // Only pay for a PointLight when the muzzle is close enough to the camera
  // to contribute noticeable surface wash (< 25m). Beyond that the sphere
  // alone is indistinguishable and the light just costs shader time.
  let flash: THREE.PointLight | undefined;
  if (camDistSq < 25 * 25) {
    flash = borrowTransientLight(col, 4, 8);
    flash?.position.copy(pos);
  }

  gameState.particles.push({
    mesh: sphere, vel: new THREE.Vector3(),
    life: 0.05, mL: 0.05, light: flash,
    _tracerPool: _muzzlePool,
  } as any);
}


/**
 * Spawn death explosion effect with ring + shockwave.
 */
export function spawnDeath(pos: THREE.Vector3, col: number): void {
  spawnImpact(pos, col, 22);

  // Death flash light
  const flash = borrowTransientLight(col, 6, 12);
  if (flash) {
    flash.position.copy(pos);
    flash.position.y = 1;
  }

  // Expanding ring
  const ring = borrowMesh(
    _deathRingPool,
    _deathRingGeo,
    getSharedBasicMat(col, 0.8, false, THREE.DoubleSide, true),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(pos);
  ring.position.y = 0.08;
  gameState.particles.push({ mesh: ring, vel: new THREE.Vector3(), life: 0.7, mL: 0.7, isRing: true, _sharedGeometry: true, _sharedMaterial: true, _pool: _deathRingPool });

  // Second outer shockwave ring
  const ring2 = borrowMesh(_shockRingPool, _shockRingGeo, _shockRingMat);
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.copy(pos);
  ring2.position.y = 0.1;
  gameState.particles.push({ mesh: ring2, vel: new THREE.Vector3(), life: 0.5, mL: 0.5, isRing: true, light: flash, _sharedGeometry: true, _sharedMaterial: true, _pool: _shockRingPool });

  // Upward ember sparks
  const emberMat = getSharedBasicMat(col, 1, true, THREE.FrontSide, false);
  for (let i = 0; i < 8; i++) {
    const ember = borrowMesh(_sparkPool, _sparkGeo, emberMat);
    ember.position.copy(pos);
    ember.position.y += 0.5;
    gameState.particles.push({
      mesh: ember,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 3,
        4 + Math.random() * 6,
        (Math.random() - 0.5) * 3,
      ),
      life: 0.6 + Math.random() * 0.4,
      mL: 1.0,
      _sharedGeometry: true,
      _sharedMaterial: true,
      _pool: _sparkPool,
    });
  }
}

/**
 * Spawn explosion effect for rockets/grenades.
 */
export function spawnExplosion(pos: THREE.Vector3, radius: number): void {
  // Bright flash
  const flash = borrowTransientLight(0xff6600, 10, radius * 3);
  flash?.position.copy(pos);

  // Fire particles
  const fireColors = [0xff6600, 0xff4400, 0xffaa00, 0xff2200];
  for (let i = 0; i < 30; i++) {
    const col = fireColors[Math.floor(Math.random() * fireColors.length)];
    const m = borrowMesh(_impactPool, _impactGeo, getSharedBasicMat(col, 1, true, THREE.FrontSide, false));
    m.position.copy(pos);
    const spd = 3 + Math.random() * 8;
    gameState.particles.push({
      mesh: m,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * spd * 2,
        Math.random() * spd,
        (Math.random() - 0.5) * spd * 2,
      ),
      life: 0.3 + Math.random() * 0.4,
      mL: 0.7,
      _sharedGeometry: true,
      _sharedMaterial: true,
      _pool: _impactPool,
    });
  }

  // Smoke puffs (dark, larger, slower)
  for (let i = 0; i < 6; i++) {
    const s = 0.15 + Math.random() * 0.15;
    const m = borrowMesh(_smokePuffPool, _smokePuffGeo, _explosionSmokeMat);
    m.scale.setScalar(s / 0.2);
    m.position.copy(pos);
    gameState.particles.push({
      mesh: m,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        1 + Math.random() * 3,
        (Math.random() - 0.5) * 2,
      ),
      life: 0.6 + Math.random() * 0.5,
      mL: 1.1,
      isSmoke: true,
      _sharedGeometry: true,
      _sharedMaterial: true,
      _pool: _smokePuffPool,
    });
  }

  // Ground scorch ring
  const scorch = borrowMesh(
    _scorchPool,
    _scorchGeo,
    getSharedBasicMat(0xff6600, 0.7, true, THREE.DoubleSide, false),
  );
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.copy(pos);
  scorch.position.y = 0.05;
  const scorchScale = Math.max(0.65, radius * 0.6);
  scorch.scale.set(scorchScale, scorchScale, scorchScale);
  gameState.particles.push({ mesh: scorch, vel: new THREE.Vector3(), life: 0.8, mL: 0.8, isRing: true, light: flash, _sharedGeometry: true, _sharedMaterial: true, _pool: _scorchPool });

  // Trigger screen shake for nearby player
  const playerDist = gameState.player.position.distanceTo(pos as any);
  if (playerDist < radius * 4) {
    const intensity = Math.max(0, 1 - playerDist / (radius * 4));
    triggerScreenShake(intensity * 0.5, 0.3);
  }
}

// ═══════════════════════════════════════════
//  ROCKET SMOKE TRAIL
// ═══════════════════════════════════════════

const _smokeGeo = new THREE.SphereGeometry(0.08, 4, 4);
const _trailEmberGeo = new THREE.SphereGeometry(0.04, 3, 3);

/**
 * Spawn smoke + ember trail particles behind a rocket.
 */
export function spawnRocketTrail(pos: THREE.Vector3): void {
  // Smoke puff
  const smoke = borrowMesh(_trailSmokePool, _smokeGeo, _trailSmokeMat);
  smoke.position.copy(pos);
  gameState.particles.push({
    mesh: smoke,
    vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.3 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8),
    life: 0.35 + Math.random() * 0.25,
    mL: 0.6,
    isSmoke: true,
    _sharedGeometry: true,
    _sharedMaterial: true,
    _pool: _trailSmokePool,
  });

  // Ember spark
  if (Math.random() < 0.6) {
    const ember = borrowMesh(_trailEmberPool, _trailEmberGeo, _trailEmberMat);
    ember.position.copy(pos);
    gameState.particles.push({
      mesh: ember,
      vel: new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2),
      life: 0.12 + Math.random() * 0.12,
      mL: 0.24,
      _sharedGeometry: true,
      _sharedMaterial: true,
      _pool: _trailEmberPool,
    });
  }
}

// ═══════════════════════════════════════════
//  SCREEN SHAKE
// ═══════════════════════════════════════════

// ── Bullet hole decals ──
const _decalGeo = new THREE.PlaneGeometry(0.12, 0.12);
const _decalMat = new THREE.MeshBasicMaterial({
  color: 0x111111, transparent: true, opacity: 0.7,
  depthWrite: false, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1,
});
const MAX_DECALS = 64;
const _decalPool: THREE.Mesh[] = [];
let _decalCursor = 0;

function initBulletHolePool(): void {
  if (_decalPool.length > 0) return;
  for (let i = 0; i < MAX_DECALS; i++) {
    const decal = new THREE.Mesh(_decalGeo, _decalMat);
    decal.visible = false;
    gameState.scene.add(decal);
    _decalPool.push(decal);
  }
}

export function spawnBulletHole(pos: THREE.Vector3, normal: THREE.Vector3 | null): void {
  initBulletHolePool();
  const decal = _decalPool[_decalCursor];
  _decalCursor = (_decalCursor + 1) % MAX_DECALS;
  decal.visible = true;
  decal.scale.set(1, 1, 1);
  decal.position.copy(pos);
  if (normal) {
    decal.position.addScaledVector(normal, 0.01);
    decal.lookAt(pos.clone().add(normal));
  } else {
    decal.rotation.x = -Math.PI / 2;
    decal.position.y = 0.02;
  }
}

let shakeIntensity = 0;
let shakeTimer = 0;

export function triggerScreenShake(intensity: number, duration: number): void {
  shakeIntensity = Math.max(shakeIntensity, intensity);
  shakeTimer = Math.max(shakeTimer, duration);
}

export function updateScreenShake(dt: number): void {
  if (shakeTimer <= 0) return;
  shakeTimer -= dt;
  const t = Math.max(0, shakeTimer);
  const shake = shakeIntensity * t * 4;
  gameState.cameraPitch += (Math.random() - 0.5) * shake * 0.03;
  gameState.cameraYaw += (Math.random() - 0.5) * shake * 0.02;
  if (shakeTimer <= 0) {
    shakeIntensity = 0;
  }
}

// ═══════════════════════════════════════════
//  BLOOD SPLATTER
// ═══════════════════════════════════════════
const _bloodGeo = new THREE.SphereGeometry(0.04, 4, 4);
const _bloodDecalGeo = new THREE.PlaneGeometry(0.2, 0.2);
const _bloodDecalMat = _bloodDecalMatShared;
const _bloodDecalRc = new THREE.Raycaster();
(_bloodDecalRc as any).firstHitOnly = true;
const _bloodDist = new THREE.Vector3();

/**
 * Spawn blood splatter particles and wall decal when an agent is hit.
 *
 * PERF: skip entirely if the hit is >60m from the camera — you can't see
 * a 5-particle splash at that range. Skip the wall-decal raycast if the
 * hit is >30m. Blood particles share a cached material (no per-spawn clone).
 */
export function spawnBloodSplatter(pos: THREE.Vector3, dir: THREE.Vector3): void {
  const cam = gameState.camera;
  if (cam) {
    _bloodDist.subVectors(pos, cam.position);
    const dSq = _bloodDist.lengthSq();
    if (dSq > 60 * 60) return;
  }

  // PERF: cap total live particles so firefights don't balloon the
  // update loop to 1000+ entries. Blood is the most frequent particle
  // source (~5/hit × many hits/sec); skipping spawn when the world is
  // already saturated is nearly invisible to the player.
  if (gameState.particles.length > 220) return;

  // Directional blood particles — reuse the shared material rather than
  // allocating new meshes/materials per hit. Reduced from 5 → 3 per hit.
  for (let i = 0; i < 3; i++) {
    const m = borrowMesh(_bloodPool, _bloodGeo, _bloodMat);
    m.position.copy(pos);
    gameState.particles.push({
      mesh: m,
      vel: new THREE.Vector3(
        dir.x * 4 + (Math.random() - 0.5) * 3,
        Math.random() * 2 + 1,
        dir.z * 4 + (Math.random() - 0.5) * 3,
      ),
      life: 0.3 + Math.random() * 0.2,
      mL: 0.5,
      _pool: _bloodPool,
      _sharedGeometry: true,
    });
  }

  // Wall decal is expensive (another raycast against all wall BVHs) —
  // only place one when the hit is near enough to matter.
  if (cam && _bloodDist.lengthSq() > 30 * 30) return;

  _bloodDecalRc.set(pos, dir);
  _bloodDecalRc.near = 0;
  _bloodDecalRc.far = 3;
  const wallHits = _bloodDecalRc.intersectObjects(gameState.wallMeshes, false);
  if (wallHits.length > 0) {
    const hp = wallHits[0].point;
    const n = wallHits[0].face?.normal?.clone().transformDirection(wallHits[0].object.matrixWorld) ?? null;
    const decal = borrowMesh(_bloodDecalPool, _bloodDecalGeo, _bloodDecalMat);
    decal.position.copy(hp);
    if (n) {
      decal.position.addScaledVector(n, 0.01);
      decal.lookAt(hp.clone().add(n));
    }
    // Fade out as particle
    gameState.particles.push({ mesh: decal, vel: new THREE.Vector3(), life: 4, mL: 4, _pool: _bloodDecalPool, _sharedGeometry: true });
  }
}

/**
 * Update all particles each frame (gravity, fade, scale).
 */
export function updateParticles(dt: number): void {
  const { particles, scene } = gameState;

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;

    if (p.life <= 0) {
      cleanupParticleVisual(p, scene);
      particles.splice(i, 1);
      continue;
    }

    const t = p.life / p.mL;
    p.mesh.position.addScaledVector(p.vel, dt);

    // Light decay
    if (p.light) {
      p.light.intensity *= Math.max(0, 1 - dt * 12);
    }

    // Tracer/muzzle pool entries share a material — don't mutate its
    // opacity (would flicker every other tracer). They're short-lived
    // enough that a constant alpha looks fine.
    if ((p as any)._tracerPool) {
      continue;
    }

    if (p.isSmoke) {
      // Smoke: grows, slows, fades
      const s = 1 + (1 - t) * 3;
      p.mesh.scale.setScalar(s);
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 2));
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t * 0.5;
    } else if (p.isRing) {
      const s = 1 + (1 - t) * 4;
      p.mesh.scale.set(s, s, s);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t * 0.8;
    } else {
      p.vel.y -= 9 * dt;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
      p.mesh.scale.setScalar(t * 0.8 + 0.2);
    }
  }
}

// ── Ambient dust motes ──
let _dustPoints: THREE.Points | null = null;
let _dustVelocities: Float32Array | null = null;
const DUST_COUNT = 120;
const DUST_RANGE = 30; // around camera

export function initAmbientDust(): void {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(DUST_COUNT * 3);
  _dustVelocities = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < DUST_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * DUST_RANGE * 2;
    positions[i * 3 + 1] = Math.random() * 6;
    positions[i * 3 + 2] = (Math.random() - 0.5) * DUST_RANGE * 2;
    _dustVelocities[i * 3] = (Math.random() - 0.5) * 0.3;
    _dustVelocities[i * 3 + 1] = (Math.random() - 0.5) * 0.08;
    _dustVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xccccaa, size: 0.06, transparent: true,
    opacity: 0.35, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _dustPoints = new THREE.Points(geo, mat);
  _dustPoints.frustumCulled = false;
  gameState.scene.add(_dustPoints);
}

export function updateAmbientDust(dt: number): void {
  if (!_dustPoints || !_dustVelocities) return;
  const posArr = _dustPoints.geometry.attributes.position.array as Float32Array;
  const cam = gameState.camera;
  for (let i = 0; i < DUST_COUNT; i++) {
    const i3 = i * 3;
    posArr[i3] += _dustVelocities[i3] * dt;
    posArr[i3 + 1] += _dustVelocities[i3 + 1] * dt;
    posArr[i3 + 2] += _dustVelocities[i3 + 2] * dt;
    // wrap around camera
    const dx = posArr[i3] - cam.position.x;
    const dz = posArr[i3 + 2] - cam.position.z;
    if (Math.abs(dx) > DUST_RANGE) posArr[i3] = cam.position.x + (Math.random() - 0.5) * DUST_RANGE * 2;
    if (Math.abs(dz) > DUST_RANGE) posArr[i3 + 2] = cam.position.z + (Math.random() - 0.5) * DUST_RANGE * 2;
    if (posArr[i3 + 1] < 0 || posArr[i3 + 1] > 6) {
      posArr[i3 + 1] = Math.random() * 5;
      _dustVelocities[i3 + 1] = (Math.random() - 0.5) * 0.08;
    }
  }
  _dustPoints.geometry.attributes.position.needsUpdate = true;
}
