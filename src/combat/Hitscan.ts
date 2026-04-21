import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { spawnImpact, spawnWallSparks, spawnTracer, spawnExplosion, spawnRocketTrail, spawnBulletHole, spawnBloodSplatter } from './Particles';
import { dealDmgPlayer, dealDmgAgent } from './Combat';
import { TEAM_BLUE, BODY_HIT_RADIUS, HEAD_HIT_RADIUS } from '@/config/constants';
import { GRENADE_CONFIG, WEAPONS, type WeaponId } from '@/config/weapons';
import type { TDMAgent } from '@/entities/TDMAgent';
import { isEnemy } from '@/core/GameModes';
import { playShot, playImpact, playExplosion, playBulletWhiz, playFriendlyFireBuzz } from '@/audio/SoundHooks';
import { movement } from '@/movement/MovementController';
import { showHitMarker } from '@/ui/HitMarkers';
import { checkSuppressionFromShot } from './Suppression';

interface ProjectilePoolEntry {
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  inUse: boolean;
}

const ROCKET_POOL_SIZE = 6;
const GRENADE_POOL_SIZE = 12;
const _rocketGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6);
const _rocketMat = new THREE.MeshStandardMaterial({ color: 0xaa4400, emissive: 0xff6600, emissiveIntensity: 2 });
const _grenadeGeo = new THREE.SphereGeometry(0.1, 8, 8);
const _grenadeMats: Record<GrenadeType, THREE.MeshStandardMaterial> = {
  frag: new THREE.MeshStandardMaterial({ color: 0x445500, emissive: 0x445500, emissiveIntensity: 0.5 }),
  smoke: new THREE.MeshStandardMaterial({ color: 0x888888, emissive: 0x888888, emissiveIntensity: 0.5 }),
  flash: new THREE.MeshStandardMaterial({ color: 0xffffaa, emissive: 0xffffaa, emissiveIntensity: 0.5 }),
};
const _smokeCloudGeo = new THREE.SphereGeometry(5, 12, 12);
const _smokeCloudMat = new THREE.MeshBasicMaterial({
  color: 0xcccccc, transparent: true, opacity: 0.45,
  depthWrite: false, side: THREE.DoubleSide,
});
const _rocketPool: ProjectilePoolEntry[] = [];

// ──────────────────────────────────────────────────────────────────────
// PERF: scratch vectors shared by every hitscanShot/shotgunBlast call.
// The hot path used to do 6+ `origin.clone()` / `dir.clone().normalize()`
// per shot plus another `new THREE.Vector3` per agent checked — with 10
// bots firing at 8–12 rounds/sec that was dozens of Vector3 allocations
// per bullet, thousands per second during active firefights, and the
// steady GC churn was visible as stutter. These scratches let the hot
// path stay allocation-free.
// ──────────────────────────────────────────────────────────────────────
const _hsOrigin = new THREE.Vector3();
const _hsDir = new THREE.Vector3();
const _hsAgPos = new THREE.Vector3();
const _hsHeadPos = new THREE.Vector3();
const _hsToAgent = new THREE.Vector3();
const _hsClosest = new THREE.Vector3();
const _hsEnd = new THREE.Vector3();
const _hsPenOrigin = new THREE.Vector3();
const _hsShotPos = new THREE.Vector3();
const _hsWhizPos = new THREE.Vector3();
const _grenadePool: ProjectilePoolEntry[] = [];

// Scratch vectors for explode() — eliminates per-agent `new Vector3()` and
// `agPos.clone().sub(pos)` allocations during grenade/rocket fights.
const _explAgPos = new THREE.Vector3();
const _explPushDir = new THREE.Vector3();
let _projectilePoolsInited = false;
let _combatProjectileWarmupGroup: THREE.Group | null = null;

function initProjectilePools(): void {
  if (_projectilePoolsInited) return;
  _projectilePoolsInited = true;

  for (let i = 0; i < ROCKET_POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(_rocketGeo, _rocketMat);
    mesh.rotation.x = Math.PI / 2;
    mesh.visible = false;
    const light = new THREE.PointLight(0xff6600, 0, 6);
    mesh.add(light);
    gameState.scene.add(mesh);
    _rocketPool.push({ mesh, light, inUse: false });
  }

  for (let i = 0; i < GRENADE_POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(
      _grenadeGeo,
      _grenadeMats.frag,
    );
    mesh.visible = false;
    const light = new THREE.PointLight(0x88aa00, 0, 3);
    mesh.add(light);
    gameState.scene.add(mesh);
    _grenadePool.push({ mesh, light, inUse: false });
  }
}

function borrowProjectileEntry(pool: ProjectilePoolEntry[]): ProjectilePoolEntry | null {
  for (const entry of pool) {
    if (entry.inUse) continue;
    entry.inUse = true;
    entry.mesh.visible = true;
    return entry;
  }
  return null;
}

function releaseProjectileEntry(entry: ProjectilePoolEntry): void {
  entry.inUse = false;
  entry.mesh.visible = false;
  entry.light.intensity = 0;
  entry.mesh.position.set(0, -1000, 0);
}

export function warmCombatProjectilePools(): void {
  initProjectilePools();
  initSmokeCloudPool();
}

export function attachCombatProjectileWarmupProxies(): void {
  if (_combatProjectileWarmupGroup || !gameState.scene || !gameState.camera) return;
  initProjectilePools();

  const group = new THREE.Group();
  group.position.copy(gameState.camera.position);
  group.position.z -= 2.6;
  group.position.y += 1.2;

  const rocket = new THREE.Mesh(_rocketGeo, _rocketMat);
  rocket.rotation.x = Math.PI / 2;
  rocket.position.set(-0.45, 0.1, 0);
  group.add(rocket);

  const frag = new THREE.Mesh(_grenadeGeo, _grenadeMats.frag);
  frag.position.set(-0.15, 0.05, 0);
  group.add(frag);

  const smoke = new THREE.Mesh(_grenadeGeo, _grenadeMats.smoke);
  smoke.position.set(0.15, 0.05, 0);
  group.add(smoke);

  const flash = new THREE.Mesh(_grenadeGeo, _grenadeMats.flash);
  flash.position.set(0.45, 0.05, 0);
  group.add(flash);

  const cloud = new THREE.Mesh(_smokeCloudGeo, _smokeCloudMat);
  cloud.position.set(0, 0.65, -0.5);
  cloud.scale.setScalar(0.18);
  group.add(cloud);

  gameState.scene.add(group);
  _combatProjectileWarmupGroup = group;
}

export function detachCombatProjectileWarmupProxies(): void {
  if (!_combatProjectileWarmupGroup) return;
  gameState.scene.remove(_combatProjectileWarmupGroup);
  _combatProjectileWarmupGroup.clear();
  _combatProjectileWarmupGroup = null;
}

function releaseBullet(b: typeof gameState.bullets[number], scene: THREE.Scene): void {
  if (b.release) {
    b.release();
    return;
  }
  b.mesh.geometry.dispose();
  if (Array.isArray(b.mesh.material)) b.mesh.material.forEach(m => m.dispose());
  else (b.mesh.material as THREE.Material).dispose();
  b.mesh.children.forEach(c => {
    if ((c as THREE.Light).isLight) (c as THREE.Light).dispose();
  });
  scene.remove(b.mesh);
}

export function hitscanShot(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  ownerType: 'player' | 'ai',
  ownerTeam: number,
  weaponId: WeaponId,
  col: number,
  ownerAgent: TDMAgent | null = ownerType === 'player' ? gameState.player : null,
  playShotAudio = true,
): boolean {
  const wep = WEAPONS[weaponId];
  const { agents, wallMeshes } = gameState;

  // Normalise dir once into a scratch; reuse everywhere below.
  _hsOrigin.copy(origin);
  _hsDir.copy(dir).normalize();

  const rc = gameState.raycaster;
  rc.set(_hsOrigin, _hsDir);
  rc.near = 0;
  rc.far = wep.range;

  const wallHits = rc.intersectObjects(wallMeshes, false);
  const wallDist = wallHits.length > 0 ? wallHits[0].distance : wep.range;

  let hitAgent: TDMAgent | null = null;
  let hitDist = wallDist;
  let isHeadshot = false;

  for (const ag of agents) {
    if (ag.isDead) continue;
    if (ownerAgent && ag === ownerAgent) continue;
    if (ownerAgent && !isEnemy(ownerAgent, ag)) continue;

    _hsAgPos.set(ag.position.x, 1.0, ag.position.z);
    _hsToAgent.subVectors(_hsAgPos, _hsOrigin);
    const proj = _hsToAgent.dot(_hsDir);
    if (proj < 0 || proj > hitDist) continue;

    _hsClosest.copy(_hsDir).multiplyScalar(proj).add(_hsOrigin);
    const bodyDist = _hsClosest.distanceTo(_hsAgPos);

    if (bodyDist < BODY_HIT_RADIUS) {
      hitAgent = ag;
      hitDist = proj;
      _hsHeadPos.set(ag.position.x, 1.42, ag.position.z);
      const headDist = _hsClosest.distanceTo(_hsHeadPos);
      isHeadshot = headDist < HEAD_HIT_RADIUS;
    }
  }

  // Friendly fire detection — warn if player shot would have hit a teammate
  if (ownerType === 'player' && !hitAgent) {
    const pAgent = gameState.player;
    for (const ag of agents) {
      if (ag.isDead || ag === pAgent) continue;
      if (isEnemy(pAgent, ag)) continue;
      _hsAgPos.set(ag.position.x, 1.0, ag.position.z);
      _hsToAgent.subVectors(_hsAgPos, _hsOrigin);
      const proj = _hsToAgent.dot(_hsDir);
      if (proj < 0 || proj > wallDist) continue;
      _hsClosest.copy(_hsDir).multiplyScalar(proj).add(_hsOrigin);
      if (_hsClosest.distanceTo(_hsAgPos) < BODY_HIT_RADIUS) {
        flashFriendlyFireWarning();
        break;
      }
    }
  }

  _hsEnd.copy(_hsDir).multiplyScalar(hitDist).add(_hsOrigin);
  checkSuppressionFromShot(origin, dir, hitDist, ownerType);
  spawnTracer(origin, _hsEnd, col);
  if (playShotAudio) {
    const isPlayerShot = ownerType === 'player';
    if (isPlayerShot) {
      playShot(weaponId, undefined, true);
    } else {
      _hsShotPos.copy(origin);
      playShot(weaponId, _hsShotPos, false);
    }
  }

  // Bullet whiz — near-miss sound for AI shots passing close to player
  if (ownerType === 'ai' && hitAgent !== gameState.player) {
    const p = gameState.player;
    _hsAgPos.set(p.position.x, 1.0, p.position.z);
    _hsToAgent.subVectors(_hsAgPos, _hsOrigin);
    const proj = _hsToAgent.dot(_hsDir);
    if (proj > 0 && proj < hitDist) {
      _hsWhizPos.copy(_hsDir).multiplyScalar(proj).add(_hsOrigin);
      const passDist = _hsWhizPos.distanceTo(_hsAgPos);
      if (passDist < 3 && passDist > 0.3) {
        playBulletWhiz(_hsWhizPos);
      }
    }
  }

  if (hitAgent) {
    let dmg = wep.damage;
    (hitAgent as any)._lastHitWasHeadshot = isHeadshot;
    if (isHeadshot) dmg *= wep.headshotMult;

    if (ownerType === 'player') {
      gameState.pShotsHit++;
      if (isHeadshot) gameState.pHeadshots++;
    }
    // Distance-based damage falloff curve
    if (wep.range > 0) {
      const rangeFrac = hitDist / wep.range;
      if (rangeFrac > 0.4) {
        // Smooth falloff: 100% at 40% range → 50% at max range
        const t = (rangeFrac - 0.4) / 0.6;
        dmg *= 1 - t * 0.5;
        (hitAgent as any)._lastHitWasFalloff = true;
      } else {
        (hitAgent as any)._lastHitWasFalloff = false;
      }
    }

    if (hitAgent === gameState.player) {
      dealDmgPlayer(dmg, ownerAgent);
    } else {
      dealDmgAgent(hitAgent, dmg, ownerAgent);
    }

    const hitCol = hitAgent.team === TEAM_BLUE ? 0x38bdf8 : 0xef4444;
    spawnImpact(_hsEnd, hitCol, isHeadshot ? 12 : 6);
    spawnBloodSplatter(_hsEnd, _hsDir);
    playImpact(_hsEnd, isHeadshot ? 'headshot' : 'body');
    return true;
  }

  if (wallHits.length > 0) {
    const normal = wallHits[0].face?.normal || null;
    const worldNormal = normal ? normal.clone().transformDirection(wallHits[0].object.matrixWorld) : null;
    // Detect surface from mesh name or material for material-aware VFX
    const meshName = (wallHits[0].object.name || '').toLowerCase();
    const surfaceType: 'metal' | 'wood' | 'concrete' = meshName.includes('metal') ? 'metal'
      : meshName.includes('wood') ? 'wood' : 'concrete';
    spawnWallSparks(_hsEnd, worldNormal, 6, surfaceType);
    spawnBulletHole(_hsEnd, worldNormal);
    playImpact(_hsEnd, 'wall');

    // Bullet penetration — high-power hitscan weapons pierce thin walls.
    // Only allow the PLAYER to wallbang — AI bots doing it feels like
    // cheating because they aim perfectly at last-known positions.
    if (ownerType === 'player' && wep.isHitscan && wep.damage >= 18 && wallHits[0].distance < wep.range * 0.7) {
      _hsPenOrigin.copy(_hsDir).multiplyScalar(0.3).add(_hsEnd);
      const remainRange = wep.range - wallHits[0].distance - 0.3;
      if (remainRange > 2) {
        const penRc = gameState.raycaster;
        penRc.set(_hsPenOrigin, _hsDir);
        penRc.far = remainRange;
        // Check no second wall blocks — done once before the agent loop,
        // not per-agent. Previous code issued one intersectObjects per
        // enemy tested, which was O(enemies × walls) per bullet.
        const penWalls = penRc.intersectObjects(wallMeshes, false);
        const blockDist = penWalls.length > 0 ? penWalls[0].distance : Infinity;
        for (const ag of agents) {
          if (ag.isDead) continue;
          if (ownerAgent && ag === ownerAgent) continue;
          if (ownerAgent && !isEnemy(ownerAgent, ag)) continue;
          _hsAgPos.set(ag.position.x, 1.0, ag.position.z);
          _hsToAgent.subVectors(_hsAgPos, _hsPenOrigin);
          const proj = _hsToAgent.dot(_hsDir);
          if (proj < 0 || proj > remainRange) continue;
          if (blockDist < proj) continue;
          _hsClosest.copy(_hsDir).multiplyScalar(proj).add(_hsPenOrigin);
          const bodyDist = _hsClosest.distanceTo(_hsAgPos);
          if (bodyDist < BODY_HIT_RADIUS) {
            // Wallbang: 30% damage
            const penDmg = wep.damage * 0.3;
            if (ag === gameState.player) {
              dealDmgPlayer(penDmg, ownerAgent);
            } else {
              dealDmgAgent(ag, penDmg, ownerAgent);
            }
            // Wallbang hit marker for player
            if (ownerType === 'player') showHitMarker(false, true);
            spawnTracer(_hsEnd, _hsClosest, col);
            const hitCol = ag.team === TEAM_BLUE ? 0x38bdf8 : 0xef4444;
            spawnImpact(_hsClosest, hitCol, 4);
            playImpact(_hsClosest, 'body');
            return true;
          }
        }
      }
    }
  }

  return false;
}

export function shotgunBlast(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  ownerType: 'player' | 'ai',
  ownerTeam: number,
  col: number,
  ownerAgent: TDMAgent | null = ownerType === 'player' ? gameState.player : null,
): void {
  const wep = WEAPONS.shotgun;
  const isPlayerShot = ownerType === 'player';
  if (isPlayerShot) {
    playShot('shotgun', undefined, true);
  } else {
    _hsShotPos.copy(origin);
    playShot('shotgun', _hsShotPos, false);
  }

  for (let i = 0; i < wep.pellets; i++) {
    // PERF: reuse the module scratch instead of allocating per pellet.
    _hsDir.copy(dir);
    _hsDir.x += (Math.random() - 0.5) * wep.aimError;
    _hsDir.y += (Math.random() - 0.5) * wep.aimError * 0.6;
    _hsDir.z += (Math.random() - 0.5) * wep.aimError;
    _hsDir.normalize();
    hitscanShot(origin, _hsDir, ownerType, ownerTeam, 'shotgun', col, ownerAgent, false);
  }
}

export function spawnRocket(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  ownerType: 'player' | 'ai',
  ownerTeam: number,
  col: number,
  ownerAgent: TDMAgent | null = ownerType === 'player' ? gameState.player : null,
): void {
  const wep = WEAPONS.rocket_launcher;
  const isPlayerShot = ownerType === 'player';
  if (isPlayerShot) {
    playShot('rocket_launcher', undefined, true);
  } else {
    _hsShotPos.copy(origin);
    playShot('rocket_launcher', _hsShotPos, false);
  }
  initProjectilePools();
  const entry = borrowProjectileEntry(_rocketPool);
  const mesh = entry?.mesh ?? new THREE.Mesh(_rocketGeo, _rocketMat.clone());
  if (!entry) {
    mesh.rotation.x = Math.PI / 2;
    gameState.scene.add(mesh);
  }
  mesh.position.copy(origin);
  const trail = entry?.light ?? new THREE.PointLight(0xff6600, 2, 6);
  trail.color.setHex(0xff6600);
  trail.intensity = 2;
  trail.distance = 6;
  if (!entry) mesh.add(trail);

  // dir IS cloned here intentionally — the bullet retains it across frames
  // (integrated in updateProjectiles), so it can't share scratch state
  // with the caller.
  gameState.bullets.push({
    mesh, pl: trail, dir: dir.clone(), ownerType, ownerTeam, ownerAgent,
    dmg: wep.damage, spd: wep.projectileSpeed, life: 4,
    isRocket: true, splashRadius: wep.splashRadius,
    release: entry ? () => releaseProjectileEntry(entry) : null,
  });
}

export type GrenadeType = 'frag' | 'smoke' | 'flash';

export function spawnGrenade(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  ownerType: 'player' | 'ai',
  ownerTeam: number,
  ownerAgent: TDMAgent | null = ownerType === 'player' ? gameState.player : null,
  life = GRENADE_CONFIG.fuseTime,
  grenadeType: GrenadeType = 'frag',
): void {
  initProjectilePools();
  const colors: Record<GrenadeType, number> = {
    frag: 0x445500,
    smoke: 0x888888,
    flash: 0xffffaa,
  };
  const material = _grenadeMats[grenadeType];
  const entry = borrowProjectileEntry(_grenadePool);
  const mesh = entry?.mesh ?? new THREE.Mesh(
    _grenadeGeo,
    material.clone(),
  );
  mesh.position.copy(origin);
  if (entry) {
    mesh.material = material;
  } else {
    gameState.scene.add(mesh);
  }

  const light = entry?.light ?? new THREE.PointLight(grenadeType === 'flash' ? 0xffffff : 0x88aa00, 0.5, 3);
  light.color.setHex(grenadeType === 'flash' ? 0xffffff : 0x88aa00);
  light.intensity = 0.5;
  light.distance = 3;
  if (!entry) mesh.add(light);

  gameState.bullets.push({
    mesh, pl: light, dir: new THREE.Vector3(dir.x * GRENADE_CONFIG.throwSpeed, 6, dir.z * GRENADE_CONFIG.throwSpeed),
    ownerType, ownerTeam, ownerAgent, dmg: grenadeType === 'frag' ? GRENADE_CONFIG.damage : 0, spd: 1, life,
    isGrenade: true, splashRadius: GRENADE_CONFIG.splashRadius,
    grenadeType,
    release: entry ? () => releaseProjectileEntry(entry) : null,
  });
}

export function updateProjectiles(dt: number): void {
  const { bullets, agents, scene, yukaObs } = gameState;

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;

    if (b.isGrenade) {
      b.dir.y -= 15 * dt;
      b.mesh.position.x += b.dir.x * dt;
      b.mesh.position.y += b.dir.y * dt;
      b.mesh.position.z += b.dir.z * dt;

      if (b.mesh.position.y < 0.1) {
        b.mesh.position.y = 0.1;
        b.dir.y *= -0.3;
        b.dir.x *= 0.7;
        b.dir.z *= 0.7;
      }

      if (b.life <= 0) {
        const gType = (b as any).grenadeType as GrenadeType | undefined;
        if (gType === 'smoke') {
          spawnSmokeCloud(b.mesh.position.clone());
        } else if (gType === 'flash') {
          triggerFlashbang(b.mesh.position.clone());
        } else {
          explode(b.mesh.position.clone(), b.splashRadius!, b.dmg, b.ownerAgent ?? null);
        }
        releaseBullet(b, scene);
        bullets[i] = bullets[bullets.length - 1];
        bullets.pop();
        i--;
      }
      continue;
    }

    if (b.isRocket) {
      // PERF: spawnRocketTrail used to receive a freshly-cloned Vec3 every
      // frame of every live rocket. Pass the mesh's own position; the
      // pooled trail reads-and-copies internally.
      spawnRocketTrail(b.mesh.position);
      b.mesh.position.x += b.dir.x * b.spd * dt;
      b.mesh.position.y += b.dir.y * b.spd * dt;
      b.mesh.position.z += b.dir.z * b.spd * dt;

      let hit = false;
      for (const ob of yukaObs) {
        const dx = b.mesh.position.x - ob.position.x;
        const dz = b.mesh.position.z - ob.position.z;
        if (dx * dx + dz * dz < (ob.boundingRadius + 0.2) ** 2) {
          hit = true;
          break;
        }
      }

      if (!hit) {
        for (const ag of agents) {
          if (ag.isDead) continue;
          if (b.ownerAgent && ag === b.ownerAgent) continue;
          if (b.ownerAgent && !isEnemy(b.ownerAgent, ag)) continue;
          const dx = b.mesh.position.x - ag.position.x;
          const dy = b.mesh.position.y - 1.0;
          const dz = b.mesh.position.z - ag.position.z;
          if (dx * dx + dy * dy + dz * dz < 0.8 ** 2) {
            hit = true;
            break;
          }
        }
      }

      if (b.mesh.position.y < 0.15) hit = true;

      if (hit || b.life <= 0) {
        explode(b.mesh.position.clone(), b.splashRadius!, b.dmg, b.ownerAgent ?? null);
        releaseBullet(b, scene);
        bullets[i] = bullets[bullets.length - 1];
        bullets.pop();
        i--;
      }
      continue;
    }

    b.mesh.position.x += b.dir.x * b.spd * dt;
    b.mesh.position.y += b.dir.y * b.spd * dt;
    b.mesh.position.z += b.dir.z * b.spd * dt;
    if (b.life <= 0) {
      releaseBullet(b, scene);
      bullets[i] = bullets[bullets.length - 1];
      bullets.pop();
      i--;
    }
  }
}

function explode(pos: THREE.Vector3, radius: number, damage: number, ownerAgent: TDMAgent | null): void {
  const { agents } = gameState;
  playExplosion(pos);
  spawnExplosion(pos, radius);

  for (const ag of agents) {
    if (ag.isDead) continue;
    if (ownerAgent && ag === ownerAgent) continue;
    if (ownerAgent && !isEnemy(ownerAgent, ag)) continue;

    _explAgPos.set(ag.position.x, 1.0, ag.position.z);
    const dist = _explAgPos.distanceTo(pos);
    if (dist < radius) {
      // Wall occlusion — don't damage targets shielded by geometry.
      // Cast a ray from the blast centre to the agent; if a wall is
      // closer than the agent the explosion is blocked.
      _explPushDir.subVectors(_explAgPos, pos);
      const agDist = _explPushDir.length();
      if (agDist > 0.1) {
        _explPushDir.normalize();
        const rc = gameState.raycaster;
        rc.set(pos, _explPushDir);
        rc.near = 0;
        rc.far = agDist;
        const wallBlock = rc.intersectObjects(gameState.wallMeshes, false);
        if (wallBlock.length > 0 && wallBlock[0].distance < agDist * 0.9) {
          continue; // wall between blast and target — skip damage
        }
      }
      const falloff = 1 - dist / radius;
      const dmg = Math.round(damage * falloff);
      if (ag === gameState.player) dealDmgPlayer(dmg, ownerAgent);
      else dealDmgAgent(ag, dmg, ownerAgent);

      // Explosion knockback — push away from blast centre
      _explPushDir.subVectors(_explAgPos, pos);
      _explPushDir.y = 0;
      if (_explPushDir.lengthSq() > 0.001) _explPushDir.normalize();
      const knockForce = falloff * 12;
      if (ag === gameState.player) {
        // Push player via movement velocity
        movement.velocity.x += _explPushDir.x * knockForce;
        movement.velocity.z += _explPushDir.z * knockForce;
        gameState.pVelY = Math.max(gameState.pVelY, falloff * 4);
      } else {
        // Push bot via YUKA velocity
        ag.velocity.x += _explPushDir.x * knockForce;
        ag.velocity.z += _explPushDir.z * knockForce;
      }
    }
  }
}

// ── Smoke grenade cloud ──
interface SmokeCloudEntry {
  pos: THREE.Vector3;
  mesh: THREE.Mesh;
  life: number;
  active: boolean;
}

const SMOKE_CLOUD_POOL_SIZE = 4;
const _smokeClouds: SmokeCloudEntry[] = [];
const SMOKE_DURATION = 8;
const SMOKE_RADIUS = 5;

function initSmokeCloudPool(): void {
  if (_smokeClouds.length > 0) return;
  for (let i = 0; i < SMOKE_CLOUD_POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(_smokeCloudGeo, _smokeCloudMat.clone());
    mesh.visible = false;
    gameState.scene.add(mesh);
    _smokeClouds.push({ pos: new THREE.Vector3(), mesh, life: 0, active: false });
  }
}

function borrowSmokeCloud(): SmokeCloudEntry {
  initSmokeCloudPool();
  let best = _smokeClouds[0];
  for (const cloud of _smokeClouds) {
    if (!cloud.active) return cloud;
    if (cloud.life < best.life) best = cloud;
  }
  return best;
}

function spawnSmokeCloud(pos: THREE.Vector3): void {
  const cloud = borrowSmokeCloud();
  const mesh = cloud.mesh;
  cloud.active = true;
  cloud.life = SMOKE_DURATION;
  cloud.pos.copy(pos);
  mesh.position.copy(pos);
  mesh.position.y = 1.5;
  mesh.scale.setScalar(0.1);
  mesh.visible = true;
  (mesh.material as THREE.MeshBasicMaterial).opacity = 0.45;
}

export function resetHitscanState(): void {
  // Clear smoke clouds
  for (const s of _smokeClouds) {
    s.active = false;
    s.life = 0;
    s.mesh.visible = false;
  }
  // Reset flash
  _flashTimer = 0;
  if (_flashOverlay) _flashOverlay.style.opacity = '0';
}

/** Returns true if a position is obscured by any active smoke cloud. */
export function isInSmoke(pos: THREE.Vector3): boolean {
  for (const s of _smokeClouds) {
    if (!s.active || s.life <= 0) continue;
    const dx = pos.x - s.pos.x;
    const dz = pos.z - s.pos.z;
    if (dx * dx + dz * dz < SMOKE_RADIUS * SMOKE_RADIUS) return true;
  }
  return false;
}

export function updateSmokeClouds(dt: number): void {
  if (_smokeClouds.length === 0) return;
  for (let i = _smokeClouds.length - 1; i >= 0; i--) {
    const s = _smokeClouds[i];
    if (!s.active) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.active = false;
      s.mesh.visible = false;
      continue;
    }
    // Fade in/out
    const mat = s.mesh.material as THREE.MeshBasicMaterial;
    if (s.life > SMOKE_DURATION - 1) {
      const t = (SMOKE_DURATION - s.life);
      s.mesh.scale.setScalar(0.1 + t * 0.9);
      mat.opacity = t * 0.45;
    } else if (s.life < 2) {
      mat.opacity = (s.life / 2) * 0.45;
    }
  }
}

// ── Flashbang grenade ──
let _flashOverlay: HTMLDivElement | null = null;
let _flashTimer = 0;
const FLASH_DURATION = 3;

function ensureFlashOverlay(): HTMLDivElement {
  if (!_flashOverlay) {
    _flashOverlay = document.createElement('div');
    _flashOverlay.id = 'flashOverlay';
    _flashOverlay.style.cssText = 'position:fixed;inset:0;background:#fff;pointer-events:none;z-index:900;opacity:0;transition:opacity 0.1s;';
    document.body.appendChild(_flashOverlay);
  }
  return _flashOverlay;
}

function triggerFlashbang(pos: THREE.Vector3): void {
  const cam = gameState.camera.position;
  const dist = cam.distanceTo(pos);
  if (dist > 15) return; // out of range

  // Check if player is facing the flash
  const toFlash = new THREE.Vector3().subVectors(pos, cam).normalize();
  const camDir = new THREE.Vector3();
  gameState.camera.getWorldDirection(camDir);
  const dot = camDir.dot(toFlash);

  // Even if not facing, close flashbangs still partially blind
  const intensity = Math.max(0, 1 - dist / 15) * (dot > 0 ? 1 : 0.3);
  if (intensity < 0.1) return;

  _flashTimer = FLASH_DURATION * intensity;
  const el = ensureFlashOverlay();
  el.style.opacity = String(Math.min(1, intensity));
  playExplosion(pos); // reuse explosion sound
}

export function updateFlashEffect(dt: number): void {
  if (_flashTimer <= 0) return;
  _flashTimer -= dt;
  const el = ensureFlashOverlay();
  if (_flashTimer <= 0) {
    el.style.opacity = '0';
  } else {
    el.style.opacity = String(Math.min(1, _flashTimer / FLASH_DURATION));
  }
}

// ── Grenade proximity warning ────────────────
const GRENADE_WARN_DIST = 10;
let grenadeWarnEl: HTMLDivElement | null = null;

function ensureGrenadeWarnEl(): HTMLDivElement {
  if (!grenadeWarnEl) {
    grenadeWarnEl = document.createElement('div');
    grenadeWarnEl.id = 'grenadeWarn';
    document.getElementById('cw')?.appendChild(grenadeWarnEl);
  }
  return grenadeWarnEl;
}

export function updateGrenadeWarning(): void {
  const { bullets, player, cameraYaw } = gameState;
  let closest: { dx: number; dz: number; dist: number } | null = null;

  for (const b of bullets) {
    if (!b.isGrenade) continue;
    if (b.ownerAgent && !isEnemy(b.ownerAgent, player)) continue;
    const dx = b.mesh.position.x - player.position.x;
    const dz = b.mesh.position.z - player.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < GRENADE_WARN_DIST && (!closest || dist < closest.dist)) {
      closest = { dx, dz, dist };
    }
  }

  const el = ensureGrenadeWarnEl();
  if (!closest) {
    el.classList.remove('on');
    return;
  }

  const angle = Math.atan2(-closest.dx, -closest.dz);
  const rel = angle - cameraYaw;
  const deg = (rel * 180 / Math.PI);
  const opacity = 0.5 + 0.5 * (1 - closest.dist / GRENADE_WARN_DIST);
  el.classList.add('on');
  el.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
  el.style.opacity = String(opacity);
}

// ── Friendly fire warning ────────────────
let ffWarnEl: HTMLDivElement | null = null;
let ffTimeout = 0;

function ensureFFWarnEl(): HTMLDivElement {
  if (!ffWarnEl) {
    ffWarnEl = document.createElement('div');
    ffWarnEl.id = 'ffWarn';
    ffWarnEl.textContent = 'FRIENDLY FIRE';
    document.getElementById('cw')?.appendChild(ffWarnEl);
  }
  return ffWarnEl;
}

function flashFriendlyFireWarning(): void {
  const el = ensureFFWarnEl();
  el.classList.add('on');
  playFriendlyFireBuzz();
  clearTimeout(ffTimeout);
  ffTimeout = window.setTimeout(() => { el.classList.remove('on'); }, 600);
}