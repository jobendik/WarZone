import { gameState } from '@/core/GameState';
import { ARENA_TEAM_TOTAL } from '@/config/constants';
import { dom } from './DOMElements';
import { getModeDefaults, getModeLabel, type GameMode } from '@/core/GameModes';
import { resetMatch } from '@/combat/Combat';
import { Audio } from '@/audio/AudioManager';
import type { BotClass } from '@/config/classes';
import { preloadBRModules } from '@/core/GameLoop';
import { startBRMatch, cleanupBR } from '@/br/BRController';
import { rollChallenges } from '@/ui/Challenges';
import { resetMatchMedals } from '@/ui/Medals';
import { rebuildWaypoints } from '@/ui/Waypoints';
import { startDynamicMusic, playMusicState, stopDynamicMusic } from '@/audio/DynamicMusic';
import { playMatchIntro } from '@/ui/MatchIntro';
import { showMainMenu } from '@/ui/MainMenu';
import { showPauseMenu, hidePauseMenu, isPauseMenuOpen } from '@/ui/PauseMenu';

export function syncLockHintVisibility(): void {
  const hint = document.getElementById('lockHint');
  if (!hint) return;

  const locked = document.pointerLockElement === gameState.renderer?.domElement;
  const scoreboardOpen = !!document.getElementById('tabboard')?.classList.contains('on');
  const shouldShow = gameState.mode === 'br'
    && !locked
    && !gameState.mainMenuOpen
    && !gameState.paused
    && !gameState.roundOver
    && !gameState._introActive
    && !scoreboardOpen
    && !gameState.keys.tab;
  hint.classList.toggle('on', shouldShow);
}

/**
 * Shows/hides the legacy simple-dropdown menu. The app now uses the full
 * MainMenu (src/ui/MainMenu.ts) as the boot entry point; this function is
 * kept only so the old `#mainMenu` node stays in sync when other code
 * toggles it (lockHint etc.). The legacy menu should never be shown to
 * the user — `index.html` no longer starts it with the `.on` class.
 */
function setMainMenuVisible(on: boolean): void {
  dom.mainMenu?.classList.toggle('on', on);
  // Do NOT touch lockHint here. The career-style MainMenu owns the
  // "main menu open" state, and lockHint is managed by the pointer-lock
  // change listener in EventManager. Forcing `.on` here caused the
  // CLICK TO DEPLOY banner to appear on top of the main menu.
  if (on) gameState.mainMenuOpen = true;
  // When on === false, leave mainMenuOpen alone — startMatchFromMenu /
  // showMainMenu manage it explicitly for the new flow.
}

/**
 * Kick off a match. Can be driven either by the legacy dropdown menu
 * (which reads `dom.modeSelect` / `dom.classSelect`) or by the new
 * MainMenu (which passes explicit overrides).
 */
export async function startMatchFromMenu(
  modeOverride?: GameMode,
  classOverride?: BotClass,
): Promise<void> {
  const mode = (modeOverride ?? (dom.modeSelect?.value as GameMode) ?? 'tdm') as GameMode;
  const playerClass = (classOverride ?? (dom.classSelect?.value as BotClass) ?? 'rifleman') as BotClass;
  const defaults = getModeDefaults(mode);
  gameState.mode = mode;
  gameState.pClass = playerClass;
  gameState.matchTime = defaults.matchTime;
  gameState.scoreLimit = defaults.scoreLimit;
  setMainMenuVisible(false);
  // Freeze the simulation while the pre-match intro (roster reveal) is
  // up. This prevents the old "bots run while the player is stuck
  // watching" bug \u2014 the scene renders, the MatchIntro animates over
  // it, but AI/projectiles/timers are halted. We unfreeze once the
  // intro is done AND pointer lock is in flight, so player and bots
  // start moving at the same instant.
  gameState.paused = true;
  gameState._pauseOnIntroEnd = false;
  gameState.mainMenuOpen = false;
  let pauseAfterIntro = false;
  document.body.classList.add('in-match');
  // Mode-specific body class drives CSS rules such as hiding the
  // CLICK-TO-DEPLOY banner everywhere except Battle Royale.
  document.body.classList.remove('mode-br', 'mode-tdm', 'mode-ffa', 'mode-ctf', 'mode-elimination', 'mode-domination', 'mode-hardpoint', 'mode-koth', 'mode-sd', 'mode-training');
  document.body.classList.add('mode-' + mode);

  if (mode === 'br') {
    await preloadBRModules();
    await startBRMatch();
  } else {
    cleanupBR();
    resetMatch(mode);
    resetMatchMedals();
    rollChallenges(3);
    if (mode !== 'training') {
      const blueAgents = gameState.agents.filter(a => a.team === 0).slice(0, ARENA_TEAM_TOTAL);
      const redAgents  = gameState.agents.filter(a => a.team === 1).slice(0, ARENA_TEAM_TOTAL);
      await playMatchIntro({
        mapName:   'Arena',
        modeLabel: getModeLabel(mode),
        teamBlue:  blueAgents.map(a => ({ name: a.name, level: 1, isPlayer: a === gameState.player })),
        teamRed:   redAgents.map(a  => ({ name: a.name, level: 1 })),
        camera:    gameState.camera,
      });
      if (gameState._pauseOnIntroEnd) {
        gameState._pauseOnIntroEnd = false;
        pauseAfterIntro = true;
      }
    }
  }

  rebuildWaypoints();

  startDynamicMusic();
  Audio.startEnvironmentAmbience();

  if (pauseAfterIntro) {
    showPauseMenu();
    return;
  }

  // Intro is done. Request pointer lock and unfreeze the simulation so
  // the player and bots start the match at the same instant.
  setTimeout(() => {
    gameState.renderer?.domElement?.requestPointerLock();
    gameState.paused = false;
    setTimeout(syncLockHintVisibility, 80);
  }, 60);
}

export function togglePause(force?: boolean): void {
  if (gameState.mainMenuOpen || gameState.roundOver) return;
  gameState.paused = typeof force === 'boolean' ? force : !gameState.paused;
  if (gameState.paused) {
    playMusicState('none');
    showPauseMenu();
    document.exitPointerLock?.();
    dom.lockHint.classList.remove('on');
  } else {
    if (isPauseMenuOpen()) hidePauseMenu();
    setTimeout(() => {
      gameState.renderer?.domElement?.requestPointerLock();
      setTimeout(syncLockHintVisibility, 80);
    }, 30);
  }
}

export function initMenus(): void {
  // Legacy dropdown menu is kept in the DOM (its <select> elements are
  // still referenced as data by startMatchFromMenu when no override is
  // passed), but it is no longer shown to the user. The new career-
  // style MainMenu (src/ui/MainMenu.ts) is the real boot UI.
  if (dom.startBtn) dom.startBtn.onclick = () => startMatchFromMenu();
  if (dom.modeSelect) dom.modeSelect.onchange = () => updateMenuCopy();
  updateMenuCopy();
  // Legacy menu stays hidden (it's `display:none` in index.html). The
  // new MainMenu drives boot UI via main.ts → showMainMenu().
  dom.mainMenu?.classList.remove('on');

  // Try playing lobby music on first interact
  const startLobbyMusic = () => {
    if (!Audio.ctx) Audio.init();
    if (gameState.mainMenuOpen) {
      playMusicState('lobby');
    }
    document.removeEventListener('click', startLobbyMusic);
  };
  document.addEventListener('click', startLobbyMusic);
}

const MODE_DESCRIPTIONS: Record<GameMode, string> = {
  tdm: 'Team Deathmatch — first to 20 kills. You start armed.',
  ffa: 'Free For All — start with a knife and loot the map.',
  ctf: 'Capture The Flag — steal the enemy flag and bring it home.',
  elimination: 'Elimination — no respawns. Last team alive wins the round. First to 3.',
  br: 'Battle Royale — large map, loot weapons, last one standing wins.',
  domination: 'Domination — capture and hold three flags to earn points.',
  hardpoint: 'Hardpoint — hold the rotating zone to score for your team.',
  koth: 'King of the Hill — control the hill to earn points. First to 200.',
  sd: 'Search & Destroy — attack or defend bomb sites. No respawns.',
  training: 'Training Range — practice your aim and test weapons.',
};

function updateMenuCopy(): void {
  if (!dom.modeSelect || !dom.startBtn) return;
  const mode = (dom.modeSelect.value || 'tdm') as GameMode;
  const label = getModeLabel(mode);
  dom.startBtn.textContent = `DEPLOY ${label}`;

  const descEl = dom.mainMenu?.querySelector('.menu-panel p.menu-sub') as HTMLElement | null
              ?? dom.mainMenu?.querySelector('.menu-panel p') as HTMLElement | null;
  if (descEl) {
    descEl.textContent = MODE_DESCRIPTIONS[mode] || '';
  }
}
