import * as THREE from 'three';
import { TEAM_BLUE } from '@/config/constants';
import type { BotClass } from '@/config/classes';
import type { TeamId } from '@/config/constants';

/**
 * Build a stylized soldier mesh for a given team and class.
 */
export function buildSoldierMesh(color: number, botClass: BotClass, team: TeamId): THREE.Group {
  const g = new THREE.Group();
  const teamDark = team === TEAM_BLUE ? 0x0a2a4a : 0x3a0a0a;
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.3, metalness: 0.3, emissive: color,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: teamDark, roughness: 0.6, metalness: 0.2 });
  const isEnemy = team !== TEAM_BLUE;
  const rimIntensity = isEnemy ? 0.6 : 0.25;
  const accentMat = new THREE.MeshStandardMaterial({
    color, roughness: 0.2, metalness: 0.5, emissive: color, emissiveIntensity: rimIntensity,
  });
  // Body gets subtle team rim glow for at-a-glance identification
  mat.emissiveIntensity = isEnemy ? 0.3 : 0.1;

  // Legs with knee pads.
  // PERF: castShadow deliberately off — see AgentAnimations.prepRenderable.
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 6), darkMat);
  legL.position.set(-0.15, 0.35, 0);
  g.add(legL);
  const legR = legL.clone();
  legR.position.x = 0.15;
  g.add(legR);

  // Boots
  const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.18), darkMat);
  bootL.position.set(-0.15, 0.04, 0.02);
  g.add(bootL);
  const bootR = bootL.clone();
  bootR.position.x = 0.15;
  g.add(bootR);

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.3), mat);
  torso.position.y = 0.98;
  g.add(torso);

  // Belt / waist accent
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.05, 0.32), accentMat);
  belt.position.y = 0.72;
  g.add(belt);

  // Shoulders
  const shoulderL = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), accentMat);
  shoulderL.position.set(-0.3, 1.2, 0);
  g.add(shoulderL);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = 0.3;
  g.add(shoulderR);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), darkMat);
  head.position.y = 1.42;
  g.add(head);

  // Visor — glowing eye slit
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.06, 0.08),
    new THREE.MeshStandardMaterial({
      color, roughness: 0.1, metalness: 0.8, emissive: color, emissiveIntensity: 0.8,
    }),
  );
  visor.position.set(0, 1.44, 0.14);
  g.add(visor);

  // Weapon
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.06, 0.45),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 }),
  );
  gun.position.set(0.22, 0.95, 0.2);
  g.add(gun);

  // Class-specific details
  if (botClass === 'sniper') {
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 6), accentMat);
    scope.rotation.z = Math.PI / 2;
    scope.position.set(0.22, 1.0, 0.38);
    g.add(scope);
    // Hood / cloak hint
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), darkMat);
    hood.position.set(0, 1.48, -0.04);
    g.add(hood);
  } else if (botClass === 'assault') {
    const armor = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.3, 0.35), darkMat);
    armor.position.y = 1.05;
    armor.position.z = 0.02;
    g.add(armor);
    // Shoulder guards
    const guardL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.14), accentMat);
    guardL.position.set(-0.3, 1.24, 0);
    g.add(guardL);
    const guardR = guardL.clone();
    guardR.position.x = 0.3;
    g.add(guardR);
  } else if (botClass === 'flanker') {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), accentMat);
    blade.position.set(-0.22, 0.85, 0.15);
    g.add(blade);
    // Lighter, sleeker silhouette — thinner torso
    torso.scale.set(0.9, 1, 0.9);
  }

  // Team ring at base — brighter, pulsing
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.55, 24),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  g.add(ring);

  return g;
}
