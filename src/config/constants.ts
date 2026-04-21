/** Arena and game constants.
 *
 * ARENA_HALF / ARENA_MARGIN were originally tuned for a symmetric 116x116
 * procedural arena centred at the origin.  The shipped tdm_map.glb is much
 * larger and off-centre, so these are now `let`s that are updated at runtime
 * by `configureArenaBounds()` after the navmesh loads.  Downstream code
 * imports them and sees the live binding.
 */
export let ARENA_HALF = 58;
export let ARENA_MARGIN = ARENA_HALF - 1.5;
export const RESPAWN_TIME = 3;
export const ARENA_TEAM_TOTAL = 7;
export const ARENA_BLUE_BOT_COUNT = ARENA_TEAM_TOTAL - 1;
export const ARENA_RED_BOT_COUNT = ARENA_TEAM_TOTAL;
export const ARENA_SPAWN_COUNT = 8;

/** Axis-aligned walkable bounds of the arena (derived from the navmesh). */
export const ARENA_BOUNDS = {
  minX: -ARENA_HALF,
  maxX: ARENA_HALF,
  minZ: -ARENA_HALF,
  maxZ: ARENA_HALF,
  centerX: 0,
  centerZ: 0,
};

/**
 * Reconfigure arena bounds from navmesh geometry and rebuild per-team spawn
 * arrays so the default (-40,-40)/(+40,+40) corners don't fall outside the
 * walkable area on an off-centre map.
 */
export function configureArenaBounds(bounds: {
  minX: number; maxX: number; minZ: number; maxZ: number;
}): void {
  ARENA_BOUNDS.minX = bounds.minX;
  ARENA_BOUNDS.maxX = bounds.maxX;
  ARENA_BOUNDS.minZ = bounds.minZ;
  ARENA_BOUNDS.maxZ = bounds.maxZ;
  ARENA_BOUNDS.centerX = (bounds.minX + bounds.maxX) * 0.5;
  ARENA_BOUNDS.centerZ = (bounds.minZ + bounds.maxZ) * 0.5;

  // Keep the symmetric `|x| > ARENA_MARGIN` safety clamps working for the
  // new bounds by widening ARENA_HALF to the largest absolute extent.
  const ext = Math.max(
    Math.abs(bounds.minX), Math.abs(bounds.maxX),
    Math.abs(bounds.minZ), Math.abs(bounds.maxZ),
  );
  ARENA_HALF = Math.max(58, Math.ceil(ext + 4));
  ARENA_MARGIN = ARENA_HALF - 1.5;

  // Rebuild team spawn corners in place so existing `import { BLUE_SPAWNS }`
  // consumers automatically see the new positions.  resolveArenaSpawn()
  // later projects each point onto the navmesh, so approximate corners are
  // fine — exact geometry is not required here.
  const inset = 6;
  const x0 = bounds.minX + inset;
  const x1 = bounds.maxX - inset;
  const z0 = bounds.minZ + inset;
  const z1 = bounds.maxZ - inset;
  const jitter = 4;
  const columns = Math.min(4, ARENA_SPAWN_COUNT);

  BLUE_SPAWNS.length = 0;
  RED_SPAWNS.length = 0;
  for (let i = 0; i < ARENA_SPAWN_COUNT; i++) {
    const dx = (i % columns) * jitter;
    const dz = Math.floor(i / columns) * jitter;
    BLUE_SPAWNS.push([x0 + dx, 0, z0 + dz]);
    RED_SPAWNS.push([x1 - dx, 0, z1 - dz]);
  }
}

/** Team identifiers */
export const TEAM_BLUE = 0 as const;
export const TEAM_RED = 1 as const;
export type TeamId = typeof TEAM_BLUE | typeof TEAM_RED;

/** Team display colors (hex) */
export const TEAM_COLORS: Record<TeamId, number> = {
  [TEAM_BLUE]: 0x38bdf8,
  [TEAM_RED]: 0xef4444,
};

/** Team display names */
export const TEAM_NAMES: Record<TeamId, string> = {
  [TEAM_BLUE]: 'BLUE',
  [TEAM_RED]: 'RED',
};

/** Spawn positions per team */
export const BLUE_SPAWNS: [number, number, number][] = [
  [-40, 0, -40], [-36, 0, -44], [-44, 0, -36],
  [-36, 0, -40], [-40, 0, -36], [-44, 0, -44],
  [-32, 0, -44], [-32, 0, -40],
];

export const RED_SPAWNS: [number, number, number][] = [
  [40, 0, 40], [36, 0, 44], [44, 0, 36],
  [36, 0, 40], [40, 0, 36], [44, 0, 44],
  [32, 0, 44], [32, 0, 40],
];

/** Agent hitbox radii (shared between Bullets and Hitscan) */
export const BODY_HIT_RADIUS = 0.55;
export const HEAD_HIT_RADIUS = 0.22;
