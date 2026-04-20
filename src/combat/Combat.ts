import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import {
  TEAM_BLUE, TEAM_RED, TEAM_COLORS,
  RESPAWN_TIME,
} from '@/config/constants';
import { spawnDamageNumber } from '@/ui/FloatingDamage';
import { onPlayerKill, onPlayerDeath } from '@/ui/Medals';
import { fireChallengeEvent } from '@/ui/Challenges';
import type { TDMAgent } from '@/entities/TDMAgent';
import { spawnDeath } from './Particles';
import { updateHUD, flashDmg } from '@/ui/HUD';
import { updateScoreboard } from '@/ui/Scoreboard';
import { addKillfeedEntry } from '@/ui/Killfeed';
import { showKillNotif } from '@/ui/KillNotification';
import {
  resetAgentAnimation, playAgentDeathAnimation,
  hasBlueSwatAssets, hasEnemyAssets,
  attachBlueSwatCharacter, attachEnemyCharacter,
} from '@/rendering/AgentAnimations';
import { CLASS_DEFAULT_WEAPON, WEAPONS, type WeaponId } from '@/config/weapons';
import { dom } from '@/ui/DOMElements';
import { showRoundSummary } from '@/ui/RoundSummary';
import {
  allowsRespawn, getFacingYawTowardsArena, getModeDefaults,
  getPlayerSpawn, getSpawnForAgent,
} from '@/core/GameModes';
import { updateObjectiveVisibility } from './Objectives';
import { applyAimFlinch } from '@/ai/HumanAim';
import { registerDeath, registerTeamKill, clearMatchMemory } from '@/ai/MatchMemory';
import { clearTeamIntel } from '@/ai/TeamIntel';
import { applyHitReaction } from './HitReactions';
import { resetPlayerRecoil } from './Recoil';
import { resetSuppression } from './Suppression';
import { showHitMarker, showKillMarker } from '@/ui/HitMarkers';
import { showDamageArc } from '@/ui/DamageArcs';
import { getPostFX } from '@/rendering/PostProcess.Bridge';
import { setViewmodelWeapon, playViewmodelHit } from '@/rendering/WeaponViewmodel';
import { isPlayerInAir } from '@/br/DropPlane';
import { onBRDeath } from '@/br/BRController';
import { playHitTaken, playKillConfirmed } from '@/audio/SoundHooks';
import { startKillcam, clearKillcamSnapshots } from '@/ui/Killcam';
import { checkStreakReward, clearStreaks } from './Streaks';
import { resetHitscanState } from './Hitscan';
import { clearFootstepTimers } from '@/ai/AIController';
import { movement } from '@/movement/MovementController';
import { applyRandomWeather } from '@/world/Lights';
import { shakeOnHit, shakeOnDeath, clearAllShake } from '@/movement/CameraShake';
import { resetAnnouncerState } from '@/audio/AnnouncerVoices';
import { Audio } from '@/audio/AudioManager';
import { stopDynamicMusic } from '@/audio/DynamicMusic';

// MORESCRIPTS — progression + new systems
import { awardAccountXP, awardWeaponXP, profileMutate } from '@/core/PlayerProfile';
import { reportContractEvent } from '@/ui/ContractSystem';
import { onPlayerKillForFieldUpgrade, chargeFromEvent } from '@/combat/FieldUpgradeController';
import { spawnRagdoll } from '@/rendering/RagdollSystem';
import { BotVoice } from '@/ai/BotVoice';
import { getActivePerkHooks } from '@/config/Loadouts';

const STREAK_NAMES: Record<number, string> = {
  3: 'KILLING SPREE',
  5: 'RAMPAGE',
  7: 'DOMINATING',
  10: 'UNSTOPPABLE',
  15: 'GODLIKE',
};
let _streakTimeout = 0;

// ── Assist tracking: per-agent damage contributors ──
const damageContributors = new Map<TDMAgent, Map<TDMAgent, number>>();

function logDamageContribution(victim: TDMAgent, attacker: TDMAgent, dmg: number): void {
  let map = damageContributors.get(victim);
  if (!map) { map = new Map(); damageContributors.set(victim, map); }
  map.set(attacker, (map.get(attacker) ?? 0) + dmg);
}

function flushAssists(victim: TDMAgent, killer: TDMAgent | null): void {
  const map = damageContributors.get(victim);
  if (!map) return;
  for (const [contributor, dmg] of map) {
    if (contributor === killer || contributor === victim) continue;
    if (contributor.isDead && contributor !== gameState.player) continue;
    if (dmg < 20) continue; // must do 20+ damage to earn assist
    // Award assist
    if (contributor === gameState.player) {
      gameState.pAssists++;
    }
    (contributor as any).assists = ((contributor as any).assists ?? 0) + 1;
    addKillfeedEntry(
      contributor.name, victim.name,
      contributor.team, victim.team,
      undefined, false, undefined, true,
    );
  }
  damageContributors.delete(victim);
}

// ── Play of the Game (POTG) tracking ──
const potgKillTimes = new Map<TDMAgent, number[]>();
const POTG_WINDOW = 10; // seconds — kills within this window count as a sequence

function trackPotgKill(killer: TDMAgent): void {
  let times = potgKillTimes.get(killer);
  if (!times) { times = []; potgKillTimes.set(killer, times); }
  times.push(gameState.worldElapsed);

  // Score: count kills within the POTG_WINDOW ending now
  const cutoff = gameState.worldElapsed - POTG_WINDOW;
  const recent = times.filter(t => t >= cutoff);
  // Prune old entries
  potgKillTimes.set(killer, recent);
  const score = recent.length;
  if (score > gameState.potgBestScore) {
    gameState.potgBestScore = score;
    gameState.potgBestAgent = killer;
    gameState.potgBestTime = recent[0]; // start of the best sequence
  }
}

export function getPotgAgent(): TDMAgent | null { return gameState.potgBestAgent; }
function getPotgTime(): number { return gameState.potgBestTime; }
export function resetPotg(): void { potgKillTimes.clear(); gameState.potgBestScore = 0; gameState.potgBestAgent = null; gameState.potgBestTime = 0; }

function showStreakBanner(streak: number): void {
  const label = STREAK_NAMES[streak];
  if (!label) return;
  const el = dom.killstreak;
  if (!el) return;
  el.textContent = `${label} — ${streak} KILLS`;
  el.classList.add('on');
  clearTimeout(_streakTimeout);
  _streakTimeout = window.setTimeout(() => el.classList.remove('on'), 2500);
}

export function applyWeaponToAgent(ag: TDMAgent, weaponId: WeaponId): void {
  const def = WEAPONS[weaponId];
  ag.weaponId = weaponId;
  ag.damage = def.damage;
  ag.fireRate = def.fireRate;
  ag.burstSize = def.burstSize;
  ag.burstDelay = def.burstDelay;
  ag.reloadTime = def.reloadTime;
  ag.magSize = def.magSize;
  ag.ammo = def.magSize;
  ag.aimError = def.aimError;
}

function applyPlayerLoadoutForMode(): void {
  const defaults = getModeDefaults(gameState.mode);
  if (defaults.playerStartsArmed) {
    const primary = CLASS_DEFAULT_WEAPON[gameState.pClass] || 'assault_rifle';
    gameState.pWeaponSlots = [primary, 'pistol'];
    gameState.pActiveSlot = 0;
  } else {
    gameState.pWeaponSlots = ['knife'];
    gameState.pActiveSlot = 0;
  }
  gameState.pWeaponId = gameState.pWeaponSlots[gameState.pActiveSlot];
  const wep = WEAPONS[gameState.pWeaponId];
  gameState.pAmmo = wep.magSize;
  gameState.pMaxAmmo = wep.magSize;
  gameState.pAmmoReserve = wep.magSize * 3;
  gameState.pReloadDuration = wep.reloadTime;
  gameState.pShootTimer = 0;
  gameState.pBurstCount = 0;
}

function applyAgentLoadoutForMode(ag: TDMAgent): void {
  if (ag === gameState.player) return;
  if (!getModeDefaults(gameState.mode).playerStartsArmed) {
    applyWeaponToAgent(ag, 'knife');
  } else {
    const weaponId: WeaponId = CLASS_DEFAULT_WEAPON[ag.botClass] || 'assault_rifle';
    applyWeaponToAgent(ag, weaponId);
  }
  ag.grenades = getModeDefaults(gameState.mode).playerStartsArmed ? 2 : 0;
}

function clearDeadTargetReferences(deadTarget: TDMAgent): void {
  for (const ag of gameState.agents) {
    if (ag === deadTarget) continue;
    if (ag.currentTarget === deadTarget) {
      ag.currentTarget = null;
      ag.hasTarget = false;
      ag.trackingTime = 0;
      ag.shootTimer = Math.max(ag.shootTimer, 0.15);
      ag.burstCount = 0;
    }
    ag.enemyMemory.delete(deadTarget.name);
  }
}

export function dealDmgPlayer(dmg: number, attacker: TDMAgent | null = null): void {
  if (gameState.pDead || gameState.roundOver) return;
  if (isPlayerInAir()) return; // invulnerable during BR drop
  // Spawn protection — immune for brief window after respawn
  if (gameState.worldElapsed < gameState.pSpawnProtectUntil) return;

  // Perk damage resistance
  const _perkHooks = getActivePerkHooks();
  dmg = dmg * (_perkHooks.damageResistMul ?? 1);

  // MORESCRIPTS — field upgrade charge from taking damage
  chargeFromEvent('damage_taken', dmg);
  gameState.pHP = Math.max(0, gameState.pHP - dmg);
  gameState.player.hp = gameState.pHP;
  updateHUD();
  flashDmg(dmg);
  playHitTaken();
  
if (attacker) {
  const attackerHS = Boolean((gameState.player as any)._lastHitWasHeadshot);
  delete (gameState.player as any)._lastHitWasHeadshot;
  spawnDamageNumber(
    new THREE.Vector3(gameState.player.position.x, 1.5, gameState.player.position.z),
    { amount: dmg, isHeadshot: attackerHS },
  );
}
  if (attacker) showDamageArc(attacker.position.x, attacker.position.z);
  // Log damage for assist tracking
  if (attacker) logDamageContribution(gameState.player, attacker, dmg);
  // Track last attacker for DBNO bleedout kill credit
  if (attacker) gameState.player.lastAttacker = attacker;
  // Store attacker position for minimap damage direction indicator
  if (attacker) {
    (gameState as any).pLastAttackerX = attacker.position.x;
    (gameState as any).pLastAttackerZ = attacker.position.z;
  }
  getPostFX()?.triggerHit(Math.min(1, dmg / 30) * 0.7);
  gameState.pLastDamageTime = gameState.worldElapsed;
  shakeOnHit(dmg / 100);

  // Aim punch — camera kick proportional to damage
  const punchScale = Math.min(1, dmg / 60);
  gameState.cameraPitch += (0.01 + punchScale * 0.025) * (Math.random() > 0.5 ? 1 : -0.6);
  gameState.cameraYaw += (Math.random() - 0.5) * punchScale * 0.02;
  playViewmodelHit();

  // Sprint cancel on significant damage
  if (dmg >= 15) {
    movement.isSprinting = false;
  }

  if (gameState.pHP <= 0) {
    // DBNO for player in elimination
    if (gameState.mode === 'elimination' && !gameState.pDBNO) {
      gameState.pDBNO = true;
      gameState.pDBNOTimer = 15;
      gameState.pHP = 1;
      gameState.player.hp = 1;
      addKillfeedEntry(attacker?.name ?? 'Enemy', 'Player', attacker?.team ?? TEAM_RED, TEAM_BLUE, 'DOWNED');
      return;
    }
    playerDied(attacker);
  }
}

function playerDied(attacker: TDMAgent | null): void {
  gameState.pDead = true;
  gameState.pDBNO = false;
  gameState.deathTime = gameState.worldElapsed;
  shakeOnDeath();
  flushAssists(gameState.player, attacker);
  if (attacker && gameState.mode !== 'br') {
    startKillcam(attacker);
  }
  gameState.player.isDead = true;
  gameState.respTimer = RESPAWN_TIME;
  dom.ds.classList.add('on');
  gameState.pDeaths++;
  gameState.pKillStreak = 0;
  clearStreaks();
  if (dom.deathTxt) dom.deathTxt.textContent = String(gameState.pDeaths);
  if (dom.dsKiller) dom.dsKiller.textContent = attacker ? attacker.name.toUpperCase() : 'UNKNOWN';
  if (dom.dsWeapon) dom.dsWeapon.textContent = attacker ? WEAPONS[attacker.weaponId].name : 'MYSTERY';
  if (gameState.mode === 'br') {
    gameState.spectatorTarget = attacker && !attacker.isDead ? attacker : gameState.agents.find((ag) => ag !== gameState.player && !ag.isDead && ag.active && (ag as any)._brState) ?? null;
  }

  clearDeadTargetReferences(gameState.player);

  if (gameState.mode === 'br') {
    onBRDeath(gameState.player);
  }

  for (const team of [TEAM_BLUE, TEAM_RED] as const) {
    if (gameState.flags[team].carriedBy === gameState.player) {
      dropFlag(team, new THREE.Vector3(gameState.player.position.x, 0, gameState.player.position.z));
    }
  }

  if (gameState.mode === 'tdm') {
    const killerTeam = attacker ? attacker.team : TEAM_RED;
    gameState.teamScores[killerTeam]++;
    updateScoreboard();
  } else if ((gameState.mode === 'ffa') && attacker) {
    attacker.kills++;
  }
onPlayerDeath(attacker);
  if (attacker) trackPotgKill(attacker);
  addKillfeedEntry(
    attacker ? attacker.name : 'Enemy',
    'Player',
    attacker ? attacker.team : TEAM_RED,
    TEAM_BLUE,
    attacker ? WEAPONS[attacker.weaponId].name : undefined,
    false,
    attacker ? attacker.weaponId : undefined,
  );
  checkGameEnd();
}

export function dealDmgAgent(ag: TDMAgent, dmg: number, attacker: TDMAgent | null = null): void {
  if (ag.isDead || gameState.roundOver) return;
  // Spawn protection for bots
  if ((ag as any)._spawnProtectUntil && gameState.worldElapsed < (ag as any)._spawnProtectUntil) return;
  ag.hp = Math.max(0, ag.hp - dmg);
  ag.alertLevel = Math.min(100, ag.alertLevel + 30);
  ag.lastDamageTime = gameState.worldElapsed;
  ag.recentDamage += dmg;
  if (attacker) {
    ag.lastAttacker = attacker;
    logDamageContribution(ag, attacker, dmg);
  }

  // Visible body stagger
  const attackerPos = attacker ? { x: attacker.position.x, z: attacker.position.z } : null;
  const wasHS = Boolean((ag as any)._lastHitWasHeadshot);
  applyHitReaction(ag, dmg, attackerPos, wasHS);

  // Aim flinch proportional to damage
  const dmgFrac = Math.min(1, dmg / ag.maxHP);
  applyAimFlinch(ag, dmgFrac);

  // Hit marker when the player scores a hit
  if (attacker === gameState.player) {
    const hsMarker = Boolean((ag as any)._lastHitWasHeadshot);
    const isFalloff = Boolean((ag as any)._lastHitWasFalloff);
    showHitMarker(hsMarker);
    spawnDamageNumber(
      new THREE.Vector3(ag.position.x, 1.5, ag.position.z),
      { amount: dmg, isHeadshot: hsMarker, isFalloff, target: ag },
    );
  }

  if (ag.hp <= 0) {
    // DBNO: in elimination mode, enter downed state instead of instant death
    if (gameState.mode === 'elimination' && !ag.isDBNO) {
      ag.isDBNO = true;
      ag.dbnoTimer = 15; // 15s bleedout
      ag.hp = 1; // keep barely alive for finish-off
      addKillfeedEntry(attacker?.name ?? 'Enemy', ag.name, attacker?.team ?? TEAM_RED, ag.team, 'DOWNED');
      return;
    }
    killAgent(ag, attacker);
  }
}

function killAgent(ag: TDMAgent, attacker: TDMAgent | null): void {
  if (ag.isDead) return;
  ag.isDead = true;
  ag.deaths++;
  flushAssists(ag, attacker);
  ag.respawnAt = gameState.worldElapsed + RESPAWN_TIME + Math.random() * 2;
  // Play a death animation on the character model. The ragdoll path was
  // removed — it looked unprofessional (agents flew off), and it also
  // occasionally left the character model detached across respawn which
  // made bots invisible until the next death cycle.
  const deathDur = playAgentDeathAnimation(ag.renderComponent);
  const rc = ag.renderComponent!;
  if (rc) {
    setTimeout(() => { if (ag.isDead) rc.visible = false; }, deathDur * 1000);
  }

  // BotVoice — victim death callout
  if (ag !== gameState.player as any) {
    BotVoice.onDeath({ id: ag.name, name: ag.name, team: ag.team === 0 ? 'blue' : 'red', position: new THREE.Vector3(ag.position.x, 0, ag.position.z) });
  }
  spawnDeath(new THREE.Vector3(ag.position.x, 0.5, ag.position.z), TEAM_COLORS[ag.team]);
  ag.confidence = Math.max(10, ag.confidence - 15);
  ag.killStreak = 0;

  // Match-wide danger tracking
  registerDeath(ag.team, ag.position.x, ag.position.z);

  // Grudge + tilt
  if (attacker && attacker !== ag && ag.personality) {
    ag.grudge = attacker;
    ag.grudgeExpiry = gameState.worldElapsed + 20 + ag.personality.revengeBias * 25;
    ag.tiltLevel = Math.min(1, ag.tiltLevel + 0.3 + ag.personality.tiltFactor * 0.3);
  }

  clearDeadTargetReferences(ag);

  if (gameState.mode === 'br') {
    onBRDeath(ag);
  }

  if (attacker) {
    attacker.kills++;
    attacker.confidence = Math.min(100, attacker.confidence + 10);
    attacker.killStreak++;
    registerTeamKill(attacker.team);
    trackPotgKill(attacker);
  }

  if (gameState.mode === 'tdm') {
    const scoringTeam = attacker ? attacker.team : (ag.team === TEAM_BLUE ? TEAM_RED : TEAM_BLUE);
    gameState.teamScores[scoringTeam]++;
    updateScoreboard();
  }

  const wasHeadshot = Boolean((ag as any)._lastHitWasHeadshot);
  delete (ag as any)._lastHitWasHeadshot;

  if (attacker === gameState.player) {
    gameState.pKills++;
    gameState.pKillStreak++;
    gameState.lastPlayerKillTime = gameState.worldElapsed;
    if (dom.killTxt) dom.killTxt.textContent = String(gameState.pKills);
    showKillNotif(ag.name, ag.team);
    showKillMarker();
    playKillConfirmed();
    showStreakBanner(gameState.pKillStreak);
    checkStreakReward(gameState.pKillStreak);
    getPostFX()?.triggerKill();
  }
  if (attacker === gameState.player) {
    const distance = attacker.position.distanceTo(ag.position);
    onPlayerKill(ag, distance, attacker.weaponId, wasHeadshot);
    fireChallengeEvent({
      type: 'kill',
      headshot: wasHeadshot,
      distance,
      weaponId: attacker.weaponId,
    });

    spawnDamageNumber(
      new THREE.Vector3(ag.position.x, 1.8, ag.position.z),
      { amount: 0, isKill: true },
    );

    // MORESCRIPTS — XP + progression tracking
    let xp = 100;
    if (wasHeadshot) xp += 50;
    if (distance > 50) xp += 75;
    awardAccountXP(xp, 'kill');
    awardWeaponXP(attacker.weaponId, wasHeadshot ? 20 : 10);

    // Contract events
    reportContractEvent({ type: 'kill' });
    if (wasHeadshot) reportContractEvent({ type: 'headshot_kill' });
    if (distance > 50) reportContractEvent({ type: 'long_range_kill', data: { distance } });
    if (distance < 4) reportContractEvent({ type: 'point_blank_kill' });
    reportContractEvent({ type: 'weapon_kill', data: { weaponId: attacker.weaponId } });

    // Field upgrade charge
    onPlayerKillForFieldUpgrade();
    chargeFromEvent('kill', 1);

    // BotVoice — bot attacker kill callout
    if (attacker && attacker !== gameState.player as any) {
      BotVoice.onKill({ id: attacker.name, name: attacker.name, team: attacker.team === 0 ? 'blue' : 'red', position: new THREE.Vector3(attacker.position.x, 0, attacker.position.z) }, wasHeadshot, false, false);
    }

    // Career stat tracking
    profileMutate((p) => {
      p.career.totalKills++;
      if (wasHeadshot) p.career.totalHeadshots++;
      if (distance > (p.career.longestKillDistance ?? 0)) p.career.longestKillDistance = distance;
    });
  }
  addKillfeedEntry(
    attacker ? attacker.name : 'Unknown',
    ag.name,
    attacker ? attacker.team : TEAM_RED,
    ag.team,
    attacker ? WEAPONS[attacker.weaponId].name : undefined,
    wasHeadshot,
    attacker ? attacker.weaponId : undefined,
  );

  // In overtime, any score wins — check immediately
  if (gameState.overtime && (gameState.mode === 'tdm' || gameState.mode === 'ctf')) {
    const winner = gameState.teamScores[TEAM_BLUE] > gameState.teamScores[TEAM_RED] ? TEAM_BLUE : TEAM_RED;
    if (gameState.teamScores[TEAM_BLUE] !== gameState.teamScores[TEAM_RED]) {
      finalizeMatch(winner);
      return;
    }
  }

  checkGameEnd();
}

export function dropFlag(team: 0 | 1, pos: THREE.Vector3): void {
  const flag = gameState.flags[team];
  flag.carriedBy = null;
  flag.home = false;
  flag.dropped = true;
  flag.dropPos.copy(pos);
  if (flag.mesh) flag.mesh.position.set(pos.x, 0, pos.z);
}

export function resetFlagToBase(team: 0 | 1): void {
  const flag = gameState.flags[team];
  flag.carriedBy = null;
  flag.dropped = false;
  flag.home = true;
  flag.dropPos.copy(flag.base);
  if (flag.mesh) flag.mesh.position.copy(flag.base);
}

export function scoreFlagCapture(carrier: TDMAgent): void {
  const enemyTeam = carrier.team === TEAM_BLUE ? TEAM_RED : TEAM_BLUE;
  gameState.teamScores[carrier.team]++;
  updateScoreboard();
  addKillfeedEntry(carrier.name, 'FLAG CAPTURE', carrier.team, enemyTeam, 'FLAG');
  resetFlagToBase(enemyTeam);
  checkGameEnd();
}

export function respawnAgent(ag: TDMAgent): void {
  ag.isDead = false;
  ag.hp = ag.maxHP;
  applyAgentLoadoutForMode(ag);
  ag.isReloading = false;
  const sp = getSpawnForAgent(ag);
  ag.position.set(sp[0], 0, sp[2]);
  ag.renderComponent!.visible = true;
  ag.renderComponent!.position.set(sp[0], 0, sp[2]);
  resetAgentAnimation(ag.renderComponent!);
  // Re-attach character model if it was detached for ragdoll physics
  if (ag.renderComponent && !ag.renderComponent.userData.characterModel) {
    if (ag.team === TEAM_BLUE && hasBlueSwatAssets()) {
      attachBlueSwatCharacter(ag.renderComponent as THREE.Group);
    } else if (ag.team === TEAM_RED && hasEnemyAssets()) {
      attachEnemyCharacter(ag.renderComponent as THREE.Group);
    }
  }
  // Reset nav state so the clamp doesn't try to bridge from the death position to the
  // respawn position (previously caused agents to teleport or snap to wrong locations).
  if (ag.navRuntime) {
    ag.navRuntime.initFromSpawn(ag.position);
  }
  // Spawn protection for bots (2 seconds)
  (ag as any)._spawnProtectUntil = gameState.worldElapsed + 2;

  ag.resetTacticalState();
  ag.grenades = getModeDefaults(gameState.mode).playerStartsArmed ? 2 : 0;
  ag.grenadeCooldown = 0;

  if (ag.nameTag) ag.nameTag.visible = true;

  for (const team of [TEAM_BLUE, TEAM_RED] as const) {
    if (gameState.flags[team].carriedBy === ag) {
      dropFlag(team, new THREE.Vector3(ag.position.x, 0, ag.position.z));
    }
  }
}

function getCurrentLeadScore(): number {
  if (gameState.mode === 'ffa') {
    return Math.max(
      gameState.pKills,
      ...gameState.agents.filter(a => a !== gameState.player).map(a => a.kills),
    );
  }
  return Math.max(gameState.teamScores[TEAM_BLUE], gameState.teamScores[TEAM_RED]);
}

/**
 * Finalise the match: freeze the simulation, swap combat music for
 * victory/defeat music, play the announcer voice line, and show the
 * post-match summary. All code paths that previously called
 * `showRoundSummary(winner)` should go through this helper so the
 * game always truly "ends" instead of continuing to play behind the
 * summary screen.
 */
function finalizeMatch(winnerTeam: number): void {
  if (gameState.roundOver) return;
  gameState.roundOver = true;
  gameState.paused = true;
  gameState.isADS = false;
  gameState.mouseHeld = false;
  document.body.classList.add('round-over');

  // Stop combat-era audio
  stopDynamicMusic();
  Audio.stopEnvironmentAmbience();
  Audio.stopAmbientMusic();
  // In case previous match's victory/defeat music is still looping
  Audio.stopLoop('music_victory');
  Audio.stopLoop('music_defeat');

  // Determine whether the local player won. For FFA, `winnerTeam` isn't
  // meaningful — compare player kills to the top bot.
  let isVictory: boolean;
  if (gameState.mode === 'ffa') {
    let topBot = 0;
    for (const ag of gameState.agents) {
      if (ag === gameState.player) continue;
      if (ag.kills > topBot) topBot = ag.kills;
    }
    isVictory = gameState.pKills >= topBot;
  } else {
    const playerTeam = (gameState.player?.team as number) ?? TEAM_BLUE;
    isVictory = winnerTeam === playerTeam;
  }

  // Announcer voice callout
  Audio.play(isVictory ? 'victory' : 'defeat');
  // Victory / defeat music loop (falls back silently if the sample
  // isn't loaded — synth music stubs return 0 duration)
  Audio.loop(isVictory ? 'music_victory' : 'music_defeat');

  // Release pointer lock so the summary buttons are interactive
  document.exitPointerLock?.();

  setTimeout(() => showRoundSummary(winnerTeam), 800);
}

function checkEliminationEnd(): void {
  if (gameState.mode !== 'elimination' || gameState.roundOver) return;

  let blueAlive = 0;
  let redAlive = 0;
  for (const ag of gameState.agents) {
    if (ag.isDead || ag.isDBNO) continue;
    if (ag.team === TEAM_BLUE) blueAlive++;
    else redAlive++;
  }
  // Player DBNO also doesn't count
  if (gameState.pDBNO) {
    if (gameState.player.team === TEAM_BLUE) blueAlive = Math.max(0, blueAlive - 1);
    else redAlive = Math.max(0, redAlive - 1);
  }
  gameState.eliminationBlueAlive = blueAlive;
  gameState.eliminationRedAlive = redAlive;

  if (blueAlive === 0 || redAlive === 0) {
    const winner = blueAlive > 0 ? TEAM_BLUE : TEAM_RED;
    gameState.teamScores[winner]++;
    updateScoreboard();

    if (gameState.teamScores[winner] >= gameState.scoreLimit) {
      finalizeMatch(winner);
    } else {
      addKillfeedEntry(
        'ROUND',
        `${gameState.teamScores[TEAM_BLUE]}-${gameState.teamScores[TEAM_RED]}`,
        winner, winner === TEAM_BLUE ? TEAM_RED : TEAM_BLUE,
        'ELIM',
      );
      setTimeout(() => startEliminationRound(), 3000);
    }
  }
}

function startEliminationRound(): void {
  gameState.eliminationRound++;
  clearAllShake();

  if (gameState.pDead) {
    gameState.pDead = false;
    gameState.player.isDead = false;
    dom.ds.classList.remove('on');
  }
  const sp = getPlayerSpawn();
  gameState.player.position.set(sp[0], 0, sp[2]);
  gameState.player.spawnPos.set(sp[0], 0, sp[2]);
  gameState.cameraYaw = getFacingYawTowardsArena(sp[0], sp[2]);
  gameState.cameraPitch = 0;
  gameState.pHP = 100;
  gameState.player.hp = 100;
  applyPlayerLoadoutForMode();
  gameState.pGrenades = 2;
  gameState.pSmokes = 1;
  gameState.pFlashbangs = 1;
  gameState.pReloading = false;
  dom.reloadBar.classList.remove('on');
  dom.reloadText.classList.remove('on');

  for (const ag of gameState.agents) {
    if (ag === gameState.player) continue;
    if (ag.isDead) {
      ag.isDead = false;
      ag.renderComponent!.visible = true;
      resetAgentAnimation(ag.renderComponent!);
    }
    const asp = getSpawnForAgent(ag);
    ag.position.set(asp[0], 0, asp[2]);
    ag.hp = ag.maxHP;
    applyAgentLoadoutForMode(ag);
    ag.resetTacticalState();
    ag.renderComponent!.position.set(asp[0], 0, asp[2]);
  }

  updateHUD();
  updateScoreboard();
}

function checkGameEnd(): void {
  if (gameState.roundOver) return;

  if (gameState.mode === 'elimination') {
    checkEliminationEnd();
    return;
  }

  const leadScore = getCurrentLeadScore();
  if (leadScore >= gameState.scoreLimit) {
    // In overtime, any score ends the match immediately
    if (gameState.mode === 'ffa') {
      finalizeMatch(TEAM_BLUE);
    } else {
      const winner = gameState.teamScores[TEAM_BLUE] >= gameState.scoreLimit ? TEAM_BLUE : TEAM_RED;
      finalizeMatch(winner);
    }
  }
}

export function resetMatch(mode = gameState.mode): void {
  gameState.mode = mode;
  if (mode === 'tdm' || mode === 'elimination' || mode === 'ffa') {
    import('@/audio/AudioManager').then(({ Audio }) => {
      const intros = ['announcer_tdm', 'announcer_eliminate', 'announcer_secure', 'announcer_green'];
      Audio.play(intros[Math.floor(Math.random() * intros.length)]);
    });
  }
  gameState.roundOver = false;
  gameState.overtime = false;
  // No warmup countdown — the match starts the moment the intro fades.
  gameState.warmupTimer = 0;
  const defaults = getModeDefaults(mode);
  gameState.matchTime = defaults.matchTime;
  gameState.matchTimeRemaining = defaults.matchTime;
  gameState.scoreLimit = defaults.scoreLimit;
  gameState.teamScores = [0, 0];
  gameState.pKills = 0;
  gameState.pDeaths = 0;
  gameState.pKillStreak = 0;
  gameState.pShotsFired = 0;
  gameState.pShotsHit = 0;
  gameState.pHeadshots = 0;
  gameState.killfeedEntries = [];
  dom.killfeed.innerHTML = '';
  gameState.eliminationRound = 0;
  resetPlayerRecoil();
  resetSuppression();
  damageContributors.clear();
  potgKillTimes.clear();
  clearKillcamSnapshots();

  // Randomize weather each round
  applyRandomWeather();

  // Clear pending AI callouts so stale intel from last match doesn't carry over
  clearTeamIntel();
  clearMatchMemory();
  resetHitscanState();
  clearFootstepTimers();
  clearAllShake();
  resetAnnouncerState();

  // Tear down any victory/defeat audio from the previous match.
  Audio.stopLoop('music_victory');
  Audio.stopLoop('music_defeat');
  document.body.classList.remove('round-over');

  if (gameState.pDead) {
    gameState.pDead = false;
    gameState.player.isDead = false;
    dom.ds.classList.remove('on');
  }

  const sp = getPlayerSpawn();
  gameState.player.position.set(sp[0], 0, sp[2]);
  gameState.player.spawnPos.set(sp[0], 0, sp[2]);
  gameState.cameraYaw = getFacingYawTowardsArena(sp[0], sp[2]);
  gameState.cameraPitch = 0;
  gameState.pHP = 100;
  gameState.player.hp = 100;
  gameState.pSpawnProtectUntil = gameState.worldElapsed + 2;
  gameState.pAssists = 0;
  applyPlayerLoadoutForMode();
  gameState.pGrenades = defaults.playerStartsArmed ? 2 : 0;
  gameState.pSmokes = defaults.playerStartsArmed ? 1 : 0;
  gameState.pFlashbangs = defaults.playerStartsArmed ? 1 : 0;
  gameState.pReloading = false;
  dom.reloadBar.classList.remove('on');
  dom.reloadText.classList.remove('on');
  gameState.spectatorTarget = null;
  gameState.isADS = false;
  setViewmodelWeapon(gameState.pWeaponId, true);

  for (const ag of gameState.agents) {
    if (ag === gameState.player) continue;
    ag.kills = 0;
    ag.deaths = 0;
    ag.confidence = 50;
    ag.killStreak = 0;
    if (ag.isDead) {
      respawnAgent(ag);
    } else {
      const asp = getSpawnForAgent(ag);
      ag.position.set(asp[0], 0, asp[2]);
      ag.hp = ag.maxHP;
      applyAgentLoadoutForMode(ag);
      ag.resetTacticalState();
      ag.renderComponent!.visible = true;
      ag.renderComponent!.position.set(asp[0], 0, asp[2]);
    }
  }

  resetFlagToBase(TEAM_BLUE);
  resetFlagToBase(TEAM_RED);
  updateObjectiveVisibility();
  updateScoreboard();
  updateHUD();
  if (dom.killTxt) dom.killTxt.textContent = '0';
  if (dom.deathTxt) dom.deathTxt.textContent = '0';
  dom.roundSummary.classList.remove('on');
  // NOTE: the old code forced `.on` on lockHint whenever the main menu
  // was open — a leftover from the legacy dropdown menu. With the
  // career-style MainMenu that flag means "the career menu is the
  // foreground UI", so showing the CLICK-TO-DEPLOY banner on top of it
  // is just a bug. lockHint is fully managed by onPointerLockChange.
}

export function updateRespawns(dt = 0.016): void {
  if (gameState.roundOver) return;

  if (gameState.mode === 'br') return;

  if (gameState.matchTimeRemaining <= 0) {
    // Overtime: if scores are tied, enter sudden death instead of ending
    if (!gameState.overtime && gameState.mode !== 'ffa') {
      if (gameState.teamScores[TEAM_BLUE] === gameState.teamScores[TEAM_RED]) {
        gameState.overtime = true;
        gameState.matchTimeRemaining = 60; // 60s overtime
        addKillfeedEntry('SYSTEM', 'OVERTIME — SUDDEN DEATH', TEAM_BLUE, TEAM_RED, 'OT');
        return;
      }
    }
    // finalizeMatch sets roundOver itself; clear our early flip so
    // the guard inside the helper doesn't reject the call.
    gameState.roundOver = false;
    if (gameState.mode === 'ffa') {
      finalizeMatch(TEAM_BLUE);
    } else {
      finalizeMatch(
        gameState.teamScores[TEAM_BLUE] >= gameState.teamScores[TEAM_RED] ? TEAM_BLUE : TEAM_RED,
      );
    }
    return;
  }

  if (!allowsRespawn()) return;

  for (const ag of gameState.agents) {
    if (ag !== gameState.player && ag.isDead && gameState.worldElapsed >= ag.respawnAt) {
      respawnAgent(ag);
    }
  }

  // ── DBNO bleedout & revive ──
  updateDBNO(dt);
}

const DBNO_REVIVE_RANGE = 3; // meters to revive
const DBNO_REVIVE_TIME = 3;  // seconds to revive

function updateDBNO(dt: number): void {
  if (gameState.mode !== 'elimination') return;

  for (const ag of gameState.agents) {
    if (!ag.isDBNO || ag.isDead) continue;

    // Bleedout timer
    ag.dbnoTimer -= dt;
    if (ag.dbnoTimer <= 0) {
      ag.isDBNO = false;
      ag.hp = 0;
      killAgent(ag, ag.lastAttacker);
      continue;
    }

    // Check if a living teammate is nearby to revive
    let reviver: TDMAgent | null = null;
    for (const ally of gameState.agents) {
      if (ally === ag || ally.isDead || ally.isDBNO || ally.team !== ag.team) continue;
      const dist = ag.position.distanceTo(ally.position);
      if (dist < DBNO_REVIVE_RANGE) {
        reviver = ally;
        break;
      }
    }

    if (reviver) {
      if (ag.dbnoReviver !== reviver) {
        ag.dbnoReviver = reviver;
        (ag as any)._reviveProgress = 0;
      }
      (ag as any)._reviveProgress = ((ag as any)._reviveProgress ?? 0) + dt;
      if ((ag as any)._reviveProgress >= DBNO_REVIVE_TIME) {
        // Revived!
        ag.isDBNO = false;
        ag.dbnoTimer = 0;
        ag.dbnoReviver = null;
        ag.hp = Math.floor(ag.maxHP * 0.3); // revive at 30% HP
        addKillfeedEntry(reviver.name, ag.name, reviver.team, ag.team, 'REVIVED');
      }
    } else {
      ag.dbnoReviver = null;
      (ag as any)._reviveProgress = 0;
    }
  }

  // Check player DBNO bleedout
  if (gameState.pDBNO) {
    gameState.pDBNOTimer -= dt;
    if (gameState.pDBNOTimer <= 0) {
      gameState.pDBNO = false;
      gameState.pHP = 0;
      gameState.player.hp = 0;
      playerDied(gameState.player.lastAttacker);
    }
  }
}
