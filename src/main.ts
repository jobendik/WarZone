import '@/styles/index.css';

import * as THREE from 'three';

import { Audio } from '@/audio/AudioManager';
import { initScene } from '@/core/SceneSetup';
import { bindEvents } from '@/core/EventManager';
import { animate } from '@/core/GameLoop';
import { buildLights } from '@/world/Lights';
import { buildArena } from '@/world/Arena';
import { buildCoverPoints } from '@/world/CoverPoints';
import { buildAgents } from '@/entities/AgentFactory';
import { buildPickups } from '@/combat/Pickups';
import { buildObjectives } from '@/combat/Objectives';
import { AsyncPathPlanner } from '@/ai/navigation/PathPlanner';
import { initViewmodel, preloadViewmodels, precompileViewmodelScene } from '@/rendering/WeaponViewmodel';
import { initMenus } from '@/ui/Menus';
import { initSettings } from '@/ui/Settings';
import {
  initAmbientDust, initParticlePools,
  attachCombatFXWarmupProxies, detachCombatFXWarmupProxies,
} from '@/combat/Particles';
import { updateHUD } from '@/ui/HUD';
import { updateScoreboard } from '@/ui/Scoreboard';
import { initPostProcess } from '@/rendering/PostProcess';
import { initScreenFX } from '@/rendering/ScreenFX';
import { setPostFX } from '@/rendering/PostProcess.Bridge';
import { initFloatingDamagePool } from '@/ui/FloatingDamage';

// MORESCRIPTS — new system imports
import { initPlayerProfile } from '@/core/PlayerProfile';
import { initLoadouts, setActiveLoadout } from '@/config/Loadouts';
import { initFieldUpgrade } from '@/combat/FieldUpgradeController';
import { initContracts } from '@/ui/ContractSystem';
import { initFinishers } from '@/combat/Finishers';
import { initEnhancedADS } from '@/combat/EnhancedADS';
import { initDynamicWeather } from '@/world/DynamicWeather';
import { initPingSystem } from '@/ui/CommWheel';
import { initEmotes } from '@/ui/Emotes';
import { initMainMenu, showMainMenu, hideMainMenu } from '@/ui/MainMenu';
import { startMatchFromMenu, syncLockHintVisibility } from '@/ui/Menus';
import { initDomination } from '@/combat/Domination';
import { initHardpoint } from '@/combat/Hardpoint';
import { initKoth } from '@/combat/KingOfTheHill';
import { initSd } from '@/combat/Searchanddestroy';
import { getSunLight, getAmbientLight } from '@/world/Lights';
import { initNavDebug } from '@/core/NavDebug';
import { gameState } from '@/core/GameState';
import type { GameMode } from '@/core/GameModes';
import { sampleMapPosition } from '@/core/GameModes';
import {
  warmCombatProjectilePools,
  attachCombatProjectileWarmupProxies,
  detachCombatProjectileWarmupProxies,
} from '@/combat/Hitscan';
import { TEAM_BLUE, TEAM_RED, TEAM_COLORS, configureArenaBounds, ARENA_BOUNDS } from '@/config/constants';
import { buildSoldierMesh } from '@/rendering/SoldierMesh';
import { makeNameTag } from '@/rendering/NameTag';
import { createHPBarGroup } from '@/rendering/HPBar';
import { createBlueSwatWarmupClone, createEnemyWarmupClone } from '@/rendering/AgentAnimations';
import { warmupTTS } from '@/ai/BotVoice';

// APEX PROTOCOL — pause drawer + victory shell
import { initPauseMenu, showPauseMenu, hidePauseMenu, isPauseMenuOpen } from '@/ui/PauseMenu';
import { initRoundSummary, showRoundSummary, hideRoundSummary } from '@/ui/RoundSummary';
import { matchState, type MedalId } from '@/ui/Medals';

// ── Loading-screen driver — drives #lsFill, #lsText, and the % readout ─
function setLoadProgress(pct: number, text: string): void {
  const fill = document.getElementById('lsFill');
  const txt = document.getElementById('lsText');
  const pctEl = document.getElementById('ldPct');
  if (fill) fill.style.width = pct + '%';
  if (txt) txt.textContent = text;
  if (pctEl) pctEl.textContent = Math.floor(pct) + '%';
}

async function precompileSceneViews(): Promise<void> {
  const { renderer, scene, camera } = gameState;
  if (!renderer || !scene || !camera) return;
  const compile = async () => {
    if (typeof (renderer as any).compileAsync === 'function') {
      await (renderer as any).compileAsync(scene, camera);
    } else {
      renderer.compile(scene, camera);
    }
  };
  const originalPosition = camera.position.clone();
  const originalQuaternion = camera.quaternion.clone();
  const views = [
    { pos: new THREE.Vector3(0, 8, 22),   lookAt: new THREE.Vector3(0, 2, 0) },
    { pos: new THREE.Vector3(24, 8, 24),  lookAt: new THREE.Vector3(0, 2, 0) },
    { pos: new THREE.Vector3(-24, 8, 24), lookAt: new THREE.Vector3(0, 2, 0) },
    { pos: new THREE.Vector3(24, 8, -24), lookAt: new THREE.Vector3(0, 2, 0) },
    { pos: new THREE.Vector3(-24, 8, -24), lookAt: new THREE.Vector3(0, 2, 0) },
  ];
  try {
    for (const view of views) {
      camera.position.copy(view.pos);
      camera.lookAt(view.lookAt);
      camera.updateMatrixWorld(true);
      await compile();
    }
  } finally {
    camera.position.copy(originalPosition);
    camera.quaternion.copy(originalQuaternion);
    camera.updateMatrixWorld(true);
  }
}

function initModeState(mode: GameMode): void {
  switch (mode) {
    case 'domination': {
      // Spread three zones across the walkable area along the map's long axis
      // so they sit on the actual level — not the defunct ±25 symmetric arena.
      const zones: Array<{ id: 'A' | 'B' | 'C'; pos: [number, number, number] }> = [
        { id: 'A', pos: toZonePos(sampleMapPosition(-0.6,  0.2)) },
        { id: 'B', pos: toZonePos(sampleMapPosition( 0.0,  0.0)) },
        { id: 'C', pos: toZonePos(sampleMapPosition( 0.6, -0.2)) },
      ];
      initDomination(gameState.scene, zones);
      break;
    }
    case 'hardpoint': {
      // Five rotating hills distributed around the map (projected to navmesh).
      const hp = [
        { id: 'crossfire', name: 'CROSSFIRE', rel: [-0.55, -0.30] as const },
        { id: 'bunker',    name: 'BUNKER',    rel: [ 0.10,  0.55] as const },
        { id: 'overwatch', name: 'OVERWATCH', rel: [ 0.55, -0.20] as const },
        { id: 'center',    name: 'CENTER',    rel: [ 0.00,  0.00] as const },
        { id: 'eastyard',  name: 'EAST YARD', rel: [ 0.60,  0.45] as const },
      ].map(p => {
        const v = sampleMapPosition(p.rel[0], p.rel[1]);
        return { id: p.id, name: p.name, position: new THREE.Vector3(v.x, 0.1, v.z), radius: 5.5 };
      });
      initHardpoint(gameState.scene, hp);
      break;
    }
    case 'koth': {
      const center = sampleMapPosition(0, 0);
      initKoth(gameState.scene, new THREE.Vector3(center.x, 0.1, center.z));
      break;
    }
    case 'sd': {
      const site = sampleMapPosition(0, 0);
      const atk = sampleMapPosition(-0.75, 0.55);
      const def = sampleMapPosition( 0.75, -0.55);
      initSd(gameState.scene, {
        bombSite: new THREE.Vector3(site.x, 0, site.z),
        attackerSpawn: new THREE.Vector3(atk.x, 0, atk.z),
        defenderSpawn: new THREE.Vector3(def.x, 0, def.z),
      });
      break;
    }
    default: break;
  }
}

function toZonePos(v: THREE.Vector3): [number, number, number] {
  return [v.x, 0.1, v.z];
}

// ─────────────────────────────────────────────────────────────────────
//  Body class helpers — drive the CSS HUD visibility gates
//  .mainmenu-open  → hide HUD, show menu
//  .in-match       → show HUD
//  .intro-active   → hide HUD during cinematic
// ─────────────────────────────────────────────────────────────────────
function setBodyState(state: 'mainmenu' | 'in-match' | 'summary' | 'pause' | 'intro'): void {
  const b = document.body.classList;
  b.remove('mainmenu-open', 'in-match', 'intro-active');
  if (state === 'mainmenu') b.add('mainmenu-open');
  if (state === 'in-match' || state === 'pause' || state === 'summary') b.add('in-match');
  if (state === 'intro') b.add('intro-active');
}

const PREVIEW_MEDALS: MedalId[] = ['first_blood', 'headshot', 'revenge', 'multi_kill'];
let roundSummaryPreviewSnapshot: null | {
  playerXP: number;
  medalsEarned: typeof matchState.medalsEarned;
} = null;

function applyRoundSummaryPreviewState(victory: boolean): number {
  if (roundSummaryPreviewSnapshot) {
    matchState.playerXP = roundSummaryPreviewSnapshot.playerXP;
    matchState.medalsEarned.length = 0;
    matchState.medalsEarned.push(...roundSummaryPreviewSnapshot.medalsEarned);
    roundSummaryPreviewSnapshot = null;
  }

  if (matchState.medalsEarned.length > 0 || matchState.playerXP > 0) {
    return matchState.playerXP;
  }

  roundSummaryPreviewSnapshot = {
    playerXP: matchState.playerXP,
    medalsEarned: matchState.medalsEarned.map((entry) => ({ ...entry })),
  };

  const now = gameState.worldElapsed;
  matchState.medalsEarned.length = 0;
  matchState.medalsEarned.push(
    ...PREVIEW_MEDALS.map((medal, index) => ({ medal, at: now - (PREVIEW_MEDALS.length - index) * 0.4 })),
  );
  matchState.playerXP = victory ? 850 : 450;
  return matchState.playerXP;
}

function restoreRoundSummaryPreviewState(): void {
  if (!roundSummaryPreviewSnapshot) return;
  matchState.playerXP = roundSummaryPreviewSnapshot.playerXP;
  matchState.medalsEarned.length = 0;
  matchState.medalsEarned.push(...roundSummaryPreviewSnapshot.medalsEarned);
  roundSummaryPreviewSnapshot = null;
}

function previewRoundSummary(victory: boolean): void {
  const teamScores = (gameState as any).teamScores as number[] | undefined;
  const playerTeam = (gameState.player?.team as number) ?? TEAM_BLUE;
  const friendlyScore = teamScores?.[playerTeam] ?? (victory ? 20 : 17);
  const hostileTeam = playerTeam === TEAM_BLUE ? TEAM_RED : TEAM_BLUE;
  const hostileScore = teamScores?.[hostileTeam] ?? (victory ? 17 : 20);
  const xpAwarded = applyRoundSummaryPreviewState(victory);

  gameState.paused = true;
  gameState.roundOver = true;
  document.body.classList.add('round-over');
  setBodyState('summary');
  hidePauseMenu();
  hideMainMenu();
  Audio.stopLoop('music_victory');
  Audio.stopLoop('music_defeat');

  showRoundSummary({
    victory,
    mode: String(gameState.mode ?? 'TDM').toUpperCase(),
    map: (gameState as any).mapName ?? 'WARZONE',
    blueScore: playerTeam === TEAM_BLUE ? friendlyScore : hostileScore,
    redScore: playerTeam === TEAM_RED ? friendlyScore : hostileScore,
    xpAwarded,
  });
}

function hideRoundSummaryPreview(): void {
  hideRoundSummary();
  restoreRoundSummaryPreviewState();
  document.body.classList.remove('round-over');
  Audio.stopLoop('music_victory');
  Audio.stopLoop('music_defeat');
  gameState.roundOver = false;
  setBodyState('mainmenu');
  showMainMenu();
}

// ─────────────────────────────────────────────────────────────────────
//  Two-phase boot (unchanged structurally from prior main.ts)
// ─────────────────────────────────────────────────────────────────────
let matchAssetsLoaded = false;
let matchAssetsLoading: Promise<void> | null = null;
let _agentWarmupGroup: THREE.Group | null = null;

function attachAgentWarmupProxies(): void {
  if (_agentWarmupGroup || !gameState.scene || !gameState.camera) return;

  const group = new THREE.Group();
  group.position.copy(gameState.camera.position);
  group.position.z -= 3.2;
  group.position.y -= 0.5;

  const placeholderBlue = buildSoldierMesh(TEAM_COLORS[TEAM_BLUE], 'rifleman', TEAM_BLUE);
  placeholderBlue.position.set(-1.35, 0, 0.35);
  group.add(placeholderBlue);

  const placeholderRed = buildSoldierMesh(TEAM_COLORS[TEAM_RED], 'assault', TEAM_RED);
  placeholderRed.position.set(1.35, 0, 0.35);
  group.add(placeholderRed);

  const swat = createBlueSwatWarmupClone();
  if (swat) { swat.position.set(-0.45, 0, -0.25); group.add(swat); }

  const enemy = createEnemyWarmupClone();
  if (enemy) { enemy.position.set(0.45, 0, -0.25); group.add(enemy); }

  const blueTag = makeNameTag('FALCON', TEAM_COLORS[TEAM_BLUE]);
  blueTag.position.set(-1.35, 2.8, 0.35); group.add(blueTag);

  const redTag = makeNameTag('VIPER', TEAM_COLORS[TEAM_RED]);
  redTag.position.set(1.35, 2.8, 0.35); group.add(redTag);

  const blueHp = createHPBarGroup().group;
  blueHp.position.set(-1.35, 0, 0.35); group.add(blueHp);
  const redHp = createHPBarGroup().group;
  redHp.position.set(1.35, 0, 0.35); group.add(redHp);

  gameState.scene.add(group);
  _agentWarmupGroup = group;
}

function detachAgentWarmupProxies(): void {
  if (!_agentWarmupGroup) return;
  gameState.scene.remove(_agentWarmupGroup);
  _agentWarmupGroup.clear();
  _agentWarmupGroup = null;
}

/**
 * Walk every region polygon in the loaded navmesh to compute the walkable
 * AABB, then push those bounds into the shared constants module so spawn
 * positions, cover generation, and boundary clamps align with the actual
 * map geometry (tdm_map.glb is asymmetric and much larger than the legacy
 * 116x116 arena).
 */
function deriveArenaBoundsFromNavMesh(): void {
  const nm = gameState.navMeshManager;
  if (!nm.navMesh) return;

  const regions: any[] = nm.mainComponent.size > 0
    ? Array.from(nm.mainComponent)
    : nm.navMesh.regions;

  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const region of regions) {
    const startEdge: any = region?.edge;
    if (!startEdge) continue;
    let e = startEdge;
    let guard = 0;
    do {
      const v = e?.vertex;
      if (v) {
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.z < minZ) minZ = v.z;
        if (v.z > maxZ) maxZ = v.z;
      }
      e = e?.next;
      if (++guard > 512) break;
    } while (e && e !== startEdge);
  }

  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minZ) || !isFinite(maxZ)) {
    console.warn('[Arena] Could not derive bounds from navmesh — keeping defaults.');
    return;
  }

  configureArenaBounds({ minX, maxX, minZ, maxZ });
  console.info(
    `[Arena] Bounds from navmesh: X=[${minX.toFixed(1)},${maxX.toFixed(1)}] ` +
    `Z=[${minZ.toFixed(1)},${maxZ.toFixed(1)}] ` +
    `center=(${ARENA_BOUNDS.centerX.toFixed(1)},${ARENA_BOUNDS.centerZ.toFixed(1)})`
  );
}

async function loadMatchAssets(): Promise<void> {
  if (matchAssetsLoaded) return;
  if (matchAssetsLoading) return matchAssetsLoading;

  matchAssetsLoading = (async () => {
    const ls = document.getElementById('loadingScreen');
    if (ls) ls.classList.add('on');

    setLoadProgress(5, 'Building arena…');
    buildLights();
    await buildArena();

    setLoadProgress(20, 'Loading NavMesh…');
    const forceRuntime = new URLSearchParams(location.search).has('runtimeNav');
    let navLoaded = false;
    if (!forceRuntime) {
      const bakedNavMeshUrl = `${import.meta.env.BASE_URL}models/tdm_map_navmesh.glb`;
      try {
        await gameState.navMeshManager.load(bakedNavMeshUrl);
        console.info(`[NavMesh] Loaded baked navmesh: ${gameState.navMeshManager.navMesh?.regions.length} regions`);
        navLoaded = true;
      } catch (err) {
        console.warn('[NavMesh] Failed to load baked navmesh — trying runtime builder.', err);
      }
    }
    if (!navLoaded) {
      try {
        const { buildNavMeshBlob } = await import('@/ai/navigation/NavMeshBuilder');
        const blobUrl = await buildNavMeshBlob();
        await gameState.navMeshManager.load(blobUrl);
        console.info('[NavMesh] Runtime navmesh built.');
      } catch (err) {
        console.warn('[NavMesh] Runtime navmesh build also failed — bots will wander without pathfinding.', err);
      }
    }
    gameState.pathPlanner = new AsyncPathPlanner(gameState.navMeshManager);
    deriveArenaBoundsFromNavMesh();
    buildCoverPoints();

    setLoadProgress(35, 'Spawning agents…');
    await buildAgents();

    setLoadProgress(55, 'Loading pickups…');
    buildPickups();
    buildObjectives();

    setLoadProgress(70, 'Loading viewmodels…');
    initViewmodel();
    await preloadViewmodels();

    setLoadProgress(80, 'Initializing FX…');
    initAmbientDust();
    initParticlePools();
    warmCombatProjectilePools();

    initFieldUpgrade();
    initFinishers();
    initEnhancedADS();
    // Dramatic initial weather roll — bias heavily toward dark/stormy.
    // Distribution: 35% storm, 20% overcast, 15% tempest, 10% dusk,
    // 8% night, 6% rain, 4% fog, 2% clear. Clear exists but is rare so
    // players mostly drop into moody / chaotic skies.
    const weatherRoll = Math.random();
    let initialWeather: 'storm' | 'overcast' | 'tempest' | 'dusk' | 'night' | 'rain' | 'fog' | 'clear';
    if (weatherRoll < 0.35) initialWeather = 'storm';
    else if (weatherRoll < 0.55) initialWeather = 'overcast';
    else if (weatherRoll < 0.70) initialWeather = 'tempest';
    else if (weatherRoll < 0.80) initialWeather = 'dusk';
    else if (weatherRoll < 0.88) initialWeather = 'night';
    else if (weatherRoll < 0.94) initialWeather = 'rain';
    else if (weatherRoll < 0.98) initialWeather = 'fog';
    else initialWeather = 'clear';
    initDynamicWeather(gameState.scene, getAmbientLight(), getSunLight(), gameState.camera, initialWeather);
    initPingSystem();
    initEmotes(gameState.camera);
    initFloatingDamagePool();

    setLoadProgress(90, 'Compiling shaders…');
    try {
      attachCombatFXWarmupProxies();
      attachCombatProjectileWarmupProxies();
      attachAgentWarmupProxies();
      await precompileSceneViews();
      await precompileViewmodelScene();
      // Force actual draw calls for every warmup proxy. compile()/compileAsync
      // upload sources but some drivers defer linking until the first real
      // render(). This hidden render pass forces the full GPU pipeline
      // (shader link, VAO setup, texture upload) during load instead of
      // the first combat frame.
      gameState.renderer.render(gameState.scene, gameState.camera);
      console.info('[perf] Shader precompile complete.');
    } catch (err) {
      console.warn('[perf] Shader precompile failed (non-fatal):', err);
    } finally {
      detachCombatFXWarmupProxies();
      detachCombatProjectileWarmupProxies();
      detachAgentWarmupProxies();
    }

    initNavDebug();

    updateHUD();
    updateScoreboard();

    setLoadProgress(100, 'Ready!');
    await new Promise((r) => setTimeout(r, 150));
    if (ls) ls.classList.remove('on');

    animate();

    matchAssetsLoaded = true;
  })();

  try {
    await matchAssetsLoading;
  } finally {
    matchAssetsLoading = null;
  }
}

async function onMainMenuStart(mode: GameMode): Promise<void> {
  gameState.mode = mode;
  await loadMatchAssets();
  initModeState(mode);

  // APEX: hide menu backdrop, light up HUD gates
  setBodyState('in-match');
  hideRoundSummary();

  await startMatchFromMenu(mode);
}

async function init(): Promise<void> {
  setLoadProgress(20, 'Initializing…');
  initScene();
  Audio.init();

  setLoadProgress(40, 'Preparing UI…');
  bindEvents();
  initMenus();
  initSettings();

  initPlayerProfile();
  initLoadouts();
  initContracts();

  // APEX: pause drawer + summary shell — wire callbacks
  initPauseMenu({
    onResume:   () => {
      gameState.paused = false;
      gameState.renderer?.domElement?.requestPointerLock();
      setTimeout(syncLockHintVisibility, 80);
    },
    onSettings: () => { /* Settings.ts drives its own panel */ },
    onRestart:  () => { gameState.paused = false; void startMatchFromMenu(gameState.mode as GameMode); },
    onQuit:     () => {
      gameState.paused = true;
      setBodyState('mainmenu');
      showMainMenu();
    },
  });
  initRoundSummary({
    onNextMatch:     () => {
      document.body.classList.remove('round-over');
      Audio.stopLoop('music_victory');
      Audio.stopLoop('music_defeat');
      void startMatchFromMenu(gameState.mode as GameMode);
    },
    onReturnToLobby: () => {
      document.body.classList.remove('round-over');
      Audio.stopLoop('music_victory');
      Audio.stopLoop('music_defeat');
      gameState.roundOver = false;
      gameState.paused = true;   // keep the world frozen while at the menu
      setBodyState('mainmenu');
      showMainMenu();
    },
  });

  setLoadProgress(60, 'Initializing screen FX…');
  const wantsPostFX = new URLSearchParams(location.search).has('postfx');
  if (wantsPostFX) {
    const fx = initPostProcess();
    setPostFX(fx);
    window.addEventListener('resize', () => fx.resize());
    console.info('[FX] GPU post-processing enabled (?postfx=1).');
  } else {
    const fx = initScreenFX();
    setPostFX(fx);
    console.info('[FX] Lightweight ScreenFX (CSS overlays) enabled. Pass ?postfx=1 for the full GPU post stack.');
  }

  setLoadProgress(80, 'Loading main menu…');

  const postFxMod = await import('@/rendering/PostProcess.Bridge');
  (window as any).__td = {
    gameState,
    get navMeshManager() { return gameState.navMeshManager; },
    get pathPlanner() { return gameState.pathPlanner; },
    perf: (await import('@/core/PerfProfiler')).perf,
    get postFX() { return postFxMod.getPostFX(); },
    renderInfo() {
      const info = gameState.renderer.info;
      return {
        calls: info.render.calls, triangles: info.render.triangles,
        points: info.render.points, lines: info.render.lines,
        frame: info.render.frame,  geometries: info.memory.geometries,
        textures: info.memory.textures, programs: info.programs?.length ?? 0,
      };
    },
    setShadows(on: boolean) {
      gameState.renderer.shadowMap.enabled = on;
      gameState.renderer.shadowMap.needsUpdate = true;
      console.log('[td] shadows =', on);
    },
    async perfTest(seconds = 6) {
      const perf = (await import('@/core/PerfProfiler')).perf;
      const fx = postFxMod.getPostFX();
      const hasComposer = !!(fx && 'composer' in fx && (fx as any).composer);
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const run = async (label: string) => {
        console.log(`%c[perfTest] ▶ ${label} — ${seconds}s`, 'color:#0af;font-weight:bold');
        perf.enable(); await wait(seconds * 1000); perf.dump();
      };
      if (!hasComposer) {
        this.setShadows(true); await wait(500);
        await run('A: shadows ON (ScreenFX / no composer)');
        this.setShadows(false); await wait(500);
        await run('B: shadows OFF (ScreenFX / no composer)');
        this.setShadows(true);
      } else {
        (fx as any).setQuality('high'); this.setShadows(true); await wait(500);
        await run('A: bloom ON, shadows ON (baseline)');
        (fx as any).setQuality('low'); this.setShadows(true); await wait(500);
        await run('B: bloom OFF, shadows ON');
        (fx as any).setQuality('low'); this.setShadows(false); await wait(500);
        await run('C: bloom OFF, shadows OFF');
        (fx as any).setQuality('high'); this.setShadows(true);
      }
      console.log(`%c[perfTest] ✓ done`, 'color:#0f0;font-weight:bold');
      console.log('renderInfo:', this.renderInfo());
    },
    previewVictory() {
      previewRoundSummary(true);
    },
    previewDefeat() {
      previewRoundSummary(false);
    },
    hideSummaryPreview() {
      hideRoundSummaryPreview();
    },
    THREE: (window as any).THREE,
  };

  // Wire MainMenu — clicking PLAY triggers Phase-2 asset load + match start.
  initMainMenu(
    (mode, loadoutIndex) => { setActiveLoadout(loadoutIndex); void onMainMenuStart(mode); },
    () => { void onMainMenuStart('training'); },
  );

  setLoadProgress(100, 'Ready!');
  await new Promise((r) => setTimeout(r, 120));
  const ls = document.getElementById('loadingScreen');
  if (ls) ls.classList.remove('on');

  document.body.classList.add('ready');
  setBodyState('mainmenu');

  gameState.paused = true;
  gameState.mainMenuOpen = true;

  // Start gate — first-click audio unlock.
  const gate = document.getElementById('startGate');
  const playBtn = document.getElementById('sgPlay');
  if (gate && playBtn) {
    gate.classList.add('on');
    const onFirstClick = async () => {
      playBtn.removeEventListener('click', onFirstClick);
      try { await Audio.resume(); } catch { /* non-fatal */ }
      try {
        const dm = await import('@/audio/DynamicMusic');
        dm.playMusicState('lobby');
      } catch (err) {
        console.warn('[main] Failed to start lobby music:', err);
      }
      warmupTTS();
      gate.classList.remove('on');
      showMainMenu();
    };
    playBtn.addEventListener('click', onFirstClick);
  } else {
    showMainMenu();
  }

}

init().catch((err) => console.error('[main] init failed:', err));
