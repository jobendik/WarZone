/**
 * GameLoop — Optimised main loop.
 *
 * Battle-royale specific perf work:
 *  - Inactive agents (deactivated arena bots in BR, not-yet-landed BR bots)
 *    are skipped by every per-agent loop, including keepInside — arena
 *    colliders are large in BR, so iterating them needlessly was costing
 *    real time
 *  - Skip all agent-related work while the player is freefalling; the
 *    drop plane sequence handles the camera, bots are inactive, and the
 *    entity manager has nothing to do
 *  - LOD-aware visuals/animations bail out on deactivated agents early
 */

import * as THREE from 'three';
import { gameState } from './GameState';
import { TEAM_BLUE, TEAM_RED } from '@/config/constants';
import { Audio } from '@/audio/AudioManager';
import { updateHeartbeat, updateSubtitles } from '@/audio/SoundHooks';
import { updatePlayer, keepInside } from '@/entities/Player';
import { updateAI } from '@/ai/AIController';
import { updateProjectiles, updateGrenadeWarning, updateSmokeClouds, updateFlashEffect } from '@/combat/Hitscan';
import { updateParticles, updateScreenShake, initAmbientDust, updateAmbientDust } from '@/combat/Particles';
import { updatePickups } from '@/combat/Pickups';
import { updateRespawns } from '@/combat/Combat';
import { updateObjectives } from '@/combat/Objectives';
import { updateVisuals } from '@/rendering/Visuals';
import { updateAgentAnimations } from '@/rendering/AgentAnimations';
import { updateHUD, updateCrosshair, updateCookTimer, updateMatchInfo } from '@/ui/HUD';
import { drawMinimap } from '@/ui/Minimap';
import { updateTabboard, updateScoreboard, showScoreboard, hideScoreboard } from '@/ui/Scoreboard';
import { updateViewmodel, renderViewmodel } from '@/rendering/WeaponViewmodel';
import { updateCompass } from '@/ui/Compass';
import { updateDamageArcs } from '@/ui/DamageArcs';
import { updateFloatingDamage } from '@/ui/FloatingDamage';
import { updateAnnouncer } from '@/ui/Announcer';
import { updateMedalTicker } from '@/ui/Medals';
import { updatePings } from '@/ui/PingSystem';
import { syncLockHintVisibility } from '@/ui/Menus';
import { updateReloadRing } from '@/ui/ReloadRing';
import { updateStanceIndicator } from '@/ui/StanceIndicator';
import { updateWaypoints } from '@/ui/Waypoints';
import { recordKillcamSnapshot } from '@/ui/Killcam';
import { getPostFX } from '@/rendering/PostProcess.Bridge';
import { updateStreaks } from '@/combat/Streaks';
import { updatePlayerRecoilRecovery } from '@/combat/Recoil';
import { updateSuppression } from '@/combat/Suppression';
import { updateHitReactions } from '@/combat/HitReactions';
import { updateDynamicMusic } from '@/audio/DynamicMusic';
import { updateAnnouncerVoices } from '@/audio/AnnouncerVoices';
import { updateCameraShake, updateLowHpShake } from '@/movement/CameraShake';
import * as brModule from '@/br/BRController';
import * as brHudModule from '@/br/BRHUD';
import * as brInvModule from '@/br/InventoryUI';

// MORESCRIPTS — new system imports
import { updateRagdolls } from '@/rendering/RagdollSystem';
import { pollFinisherInput, updateFinisher, updateFinisherPrompt } from '@/combat/Finishers';
import { updateDynamicWeather } from '@/world/DynamicWeather';
import { updateContractHud } from '@/ui/ContractSystem';
import { updateFieldUpgrade } from '@/combat/FieldUpgradeController';
import { getDomState, updateDomination } from '@/combat/Domination';
import { getHardpointState, updateHardpoint } from '@/combat/Hardpoint';
import { getKothState, updateKoth } from '@/combat/KingOfTheHill';
import { getSdState, updateSd } from '@/combat/Searchanddestroy';
import { updateSprays } from '@/ui/Emotes';
import { updatePingSystem } from '@/ui/CommWheel';
import { updateOverlay as updateADSOverlay } from '@/combat/EnhancedADS';
import { isInTrainingRange, updateTrainingRange } from '@/combat/TrainingRange';
import { updateNavDebug } from '@/core/NavDebug';
import { perf } from '@/core/PerfProfiler';
import { getModeLabel } from '@/core/GameModes';

let _hudThrottle = 0;
let _minimapThrottle = 0;

// ── FPS counter ──
let _fpsFrames = 0;
let _fpsLastTime = 0;
let _fpsDisplay = 0;

function getHudScores(): { blue: number; red: number } {
  if (gameState.mode === 'domination') {
    const state = getDomState();
    if (state) return { blue: state.scoreBlue, red: state.scoreRed };
  } else if (gameState.mode === 'hardpoint') {
    const state = getHardpointState();
    if (state) return { blue: Math.floor(state.scoreBlue), red: Math.floor(state.scoreRed) };
  } else if (gameState.mode === 'koth') {
    const state = getKothState();
    if (state) return { blue: Math.floor(state.holdBlue), red: Math.floor(state.holdRed) };
  } else if (gameState.mode === 'sd') {
    const state = getSdState();
    if (state) return { blue: state.roundBlue, red: state.roundRed };
  }

  return {
    blue: gameState.teamScores[TEAM_BLUE] ?? 0,
    red: gameState.teamScores[TEAM_RED] ?? 0,
  };
}

function updateHudMatchSlate(): void {
  const scores = getHudScores();
  updateMatchInfo(
    getModeLabel(gameState.mode),
    gameState.matchTimeRemaining,
    scores.blue,
    scores.red,
  );
}

function syncScoreboardVisibility(): void {
  const shouldShow = !!gameState.keys.tab
    && !gameState.paused
    && !gameState.mainMenuOpen
    && !gameState.roundOver
    && !gameState._introActive;

  if (shouldShow) showScoreboard();
  else hideScoreboard();
  syncLockHintVisibility();
}

// ── Warmup countdown — DISABLED ────────────────────────────────
// The old 3-2-1-FIGHT countdown has been removed. Matches begin the
// instant the intro overlay finishes. `warmupTimer` remains in
// GameState as a no-op for backwards compatibility with a handful of
// callers (DynamicMusic, AnnouncerVoices) that still read the field.

let _rafId = 0;
function stopLoop(): void { cancelAnimationFrame(_rafId); }

export function animate(): void {
  _rafId = requestAnimationFrame(animate);

  const rawDt = Math.min(gameState.time.update().getDelta(), 0.05);
  const frozen = !!gameState.paused;
  // Death slow-mo: 30% speed for 0.4s on player death
  // Post-kill zoom: 60% speed for 0.2s after player scores a kill
  let slowMo = 1;
  if (gameState.pDead && (gameState.worldElapsed - (gameState.deathTime ?? 0)) < 0.4) {
    slowMo = 0.3;
  } else if (!gameState.pDead && (gameState.worldElapsed - gameState.lastPlayerKillTime) < 0.2) {
    slowMo = 0.6;
  }
  // Apply global timeScale (used by finisher system for cinematic slow-mo)
  slowMo *= (gameState.timeScale ?? 1);
  const dt = frozen ? 0 : rawDt * slowMo;
  const isBR = gameState.mode === 'br';

  if (gameState.floorMat?.uniforms?.uTime) {
    gameState.floorMat.uniforms.uTime.value = gameState.worldElapsed;
  }

  if (!frozen && dt > 0) {
    gameState.worldElapsed += dt;

    gameState.matchTimeRemaining = Math.max(0, gameState.matchTimeRemaining - dt);
    gameState.perceptionFrame++;

    // In BR, advance drop/zone/bot state before the player update so
    // isPlayerInAir() reflects the current frame's drop state.
    if (isBR && brModule.isBRActive()) {
      brModule.updateBR(dt);
    }

    updatePlayer(dt);

    if (!isBR || !brModule.isBRActive()) {
      perf.begin('updateAI');
      for (const ag of gameState.agents) {
        if (!ag.active) continue;
        updateAI(ag, dt);
      }
      perf.end('updateAI');
    }

    recordKillcamSnapshot();
    updateHeartbeat(dt);
    updateSubtitles(dt);

    const camFwd = new THREE.Vector3();
    gameState.camera.getWorldDirection(camFwd);
    Audio.updateListener(gameState.camera.position, camFwd);

    perf.begin('projectiles+particles');
    updateProjectiles(dt);
    updateSmokeClouds(dt);
    updateFlashEffect(dt);
    updateParticles(dt);
    updateAmbientDust(dt);
    updateScreenShake(dt);
    updateCameraShake(dt);
    updateLowHpShake(gameState.pHP / 100);
    perf.end('projectiles+particles');

    if (!isBR) updatePickups();

    updateObjectives();
    updateRespawns(dt);

    // In BR we want to skip heavy per-agent work while the player is on
    // the plane. Once the player jumps, bots are active.
    const brPhase = isBR ? brModule.getBRPhase() : null;
    const brOnPlane = brPhase === 'airdrop';

    if (!brOnPlane) {
      perf.begin('entityManager+navRuntime');
      gameState.entityManager.update(dt);
      gameState.pathPlanner?.update();

      // Post-movement navmesh clamp — MUST run after entityManager moves entities.
      // Running it before (e.g. inside updateAI) clamps the pre-movement position,
      // which is a no-op; YUKA then moves the bot to an unclamped position.
      for (const ag of gameState.agents) {
        if (!ag.active || ag.isDead || ag === gameState.player) continue;
        ag.navRuntime?.update();
      }
      perf.end('entityManager+navRuntime');
    }

    // keepInside is cheap per-call but iterates arena colliders each time.
    // In BR there are hundreds of wall colliders — skip inactive agents.
    if (!brOnPlane && !gameState.navMeshManager.navMesh) {
      for (const ag of gameState.agents) {
        if (ag === gameState.player || ag.isDead || !ag.active) continue;
        keepInside(ag);
      }
    }

    updateSuppression(dt);
    updateHitReactions(dt);
    updatePlayerRecoilRecovery(dt);
    updateDynamicMusic(dt);
    updateAnnouncerVoices(dt);

    // MORESCRIPTS — new system updates
    updateRagdolls(dt);
    pollFinisherInput();
    updateFinisher(dt);
    updateFinisherPrompt();
    updateDynamicWeather(dt, gameState.camera.position);
    updateFieldUpgrade(dt);
    updateSprays();
    updatePingSystem(dt);

    // Mode-specific updates
    if (gameState.mode === 'domination') updateDomination(dt);
    else if (gameState.mode === 'hardpoint') updateHardpoint(dt);
    else if (gameState.mode === 'koth') updateKoth(dt);
    else if (gameState.mode === 'sd') updateSd(dt);

    updateContractHud();
    updateADSOverlay();
    if (isInTrainingRange()) updateTrainingRange(dt);

    if (brOnPlane) {
      // Plane window: nothing agent-related runs. Bots are inactive,
      // visuals not needed.
    } else if (isBR) {
      perf.begin('visuals+anims(BR)');
      updateVisualsLOD();
      updateAgentAnimationsLOD(dt);
      perf.end('visuals+anims(BR)');
    } else {
      perf.begin('visuals');
      updateVisuals();
      perf.end('visuals');
      perf.begin('agentAnims');
      updateAgentAnimations(gameState.agents, dt);
      perf.end('agentAnims');
    }

    updateDamageArcs(dt);
    updateGrenadeWarning();
    updateFloatingDamage(dt);
    updateAnnouncer(dt);
    updatePings(dt);
    updateStanceIndicator();
    updateWaypoints();
    updateMedalTicker(dt);
    updateStreaks(dt);
    updateNavDebug();
  }

  updateHUD();
  updateHudMatchSlate();
  updateCrosshair();
  updateCookTimer();

  _minimapThrottle++;
  if (!isBR || _minimapThrottle % 2 === 0) drawMinimap();

  _hudThrottle++;
  if (_hudThrottle % 3 === 0) {
    updateScoreboard();
    updateTabboard();
  }
  syncScoreboardVisibility();

  updateCompass();
  updateReloadRing();

  if (isBR) brHudModule.updateBRHUD();
  if (isBR) brInvModule.updatePickupPrompt();

  updateViewmodel(rawDt);

  const fx = getPostFX();
  if (fx) {
    const hpT = Math.max(0, 1 - gameState.pHP / 35);
    fx.setLowHp(gameState.pDead ? 0 : hpT);
    fx.update(rawDt);
  }

  // Render path: use composer only if the installed FX provides one
  // (i.e. the GPU post-process stack). Otherwise render directly — the
  // DOM-overlay ScreenFX doesn't touch the render target.
  if (fx && 'composer' in fx && fx.composer) {
    perf.begin('render(postFX)');
    fx.composer.render();
    perf.end('render(postFX)');
  } else {
    perf.begin('render');
    gameState.renderer.render(gameState.scene, gameState.camera);
    perf.end('render');
  }

  renderViewmodel();

  // Clear per-frame mouse delta after all systems have consumed it
  gameState.mouseDeltaX = 0;
  gameState.mouseDeltaY = 0;

  perf.markFrame();

  // ── FPS counter ──
  _fpsFrames++;
  const now = performance.now();
  if (now - _fpsLastTime >= 1000) {
    _fpsDisplay = _fpsFrames;
    _fpsFrames = 0;
    _fpsLastTime = now;
  }
  if (gameState.showFPS) {
    const fpsEl = document.getElementById('fpsCounter');
    if (fpsEl) fpsEl.textContent = `${_fpsDisplay} FPS`;
  }
}

/**
 * BR visuals — hides distant bots and inactive agents, only updates HP
 * bars and name tags within viewing range. Inactive agents (including
 * not-yet-landed bots) are handled first so we spend zero time on them.
 */
function updateVisualsLOD(): void {
  const { agents, player, camera } = gameState;
  const px = player.position.x;
  const pz = player.position.z;

  for (const ag of agents) {
    if (ag === player) continue;

    if (!ag.active || ag.isDead) {
      if (ag.renderComponent) ag.renderComponent.visible = false;
      if (ag.nameTag) ag.nameTag.visible = false;
      if (ag.hpBarGroup) ag.hpBarGroup.visible = false;
      continue;
    }

    const dx = ag.position.x - px;
    const dz = ag.position.z - pz;
    const d2 = dx * dx + dz * dz;

    if (d2 > 160 * 160) {
      if (ag.renderComponent) ag.renderComponent.visible = false;
      continue;
    }

    if (ag.renderComponent) ag.renderComponent.visible = true;

    if (ag.hpBarGroup) {
      const showHP = d2 < 45 * 45;
      ag.hpBarGroup.visible = showHP;
      if (showHP) {
        ag.hpBarGroup.quaternion.copy(camera.quaternion);
        const pct = Math.max(0, ag.hp / ag.maxHP);
        ag.hpBarFg!.scale.x = Math.max(0.01, pct);
        ag.hpBarFg!.position.x = -(1 - pct) * 0.5;
        let barColor: number;
        if (pct > 0.6) barColor = 0x22c55e;
        else if (pct > 0.3) barColor = 0xf59e0b;
        else barColor = 0xef4444;
        (ag.hpBarFg!.material as THREE.MeshBasicMaterial).color.setHex(barColor);
      }
    }

    if (ag.nameTag) {
  const dist = Math.sqrt(d2);

  // Hide if too close (huge on screen) or too far (visual clutter)
  const showTag = dist > 5 && dist < 22;

  ag.nameTag.visible = showTag;

  if (showTag) {
    // Keep apparent screen size much more stable.
    // Perspective makes nearby sprites huge; scaling by distance counters that.
    const s = THREE.MathUtils.clamp(dist * 0.055, 0.42, 0.95);
    ag.nameTag.scale.set(0.9 * s, 0.22 * s, 1);
  }
}
  }
}

/**
 * Only animate skeletons for nearby, active agents. Far bots were
 * already downgraded to the cheap procedural mesh by BRBots' LOD system,
 * so their render component has no agentAnimController and is skipped
 * by the controller check inside updateAgentAnimations itself.
 */
function updateAgentAnimationsLOD(dt: number): void {
  const px = gameState.player.position.x;
  const pz = gameState.player.position.z;
  const nearAgents: import('@/entities/TDMAgent').TDMAgent[] = [];

  for (const ag of gameState.agents) {
    if (ag === gameState.player || ag.isDead || !ag.active) continue;
    const dx = ag.position.x - px;
    const dz = ag.position.z - pz;
    if (dx * dx + dz * dz < 100 * 100) nearAgents.push(ag);
  }

  updateAgentAnimations(nearAgents, dt);
}

export async function preloadBRModules(): Promise<void> {
  // BR modules are now statically imported; this function is kept for API
  // compatibility but no longer needs to do lazy loading.
}
