function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`DOM element #${id} not found`);
  return el as T;
}

function maybeEl<T extends HTMLElement>(id: string): T | null {
  return (document.getElementById(id) as T | null) ?? null;
}

/** Lookup for SVG elements (which don't extend HTMLElement). */
function maybeSvg<T extends SVGElement>(id: string): T | null {
  return (document.getElementById(id) as unknown as T | null) ?? null;
}

export const dom = {
  get cw() { return getEl<HTMLDivElement>('cw'); },

  // Health / armor
  get hpFill() { return getEl<HTMLDivElement>('hpFill'); },
  get hpTxt() { return getEl<HTMLDivElement>('hpTxt'); },
  get armorFill() { return maybeEl<HTMLDivElement>('armorFill'); },
  get armorTxt() { return maybeEl<HTMLDivElement>('armorTxt'); },

  // Ammo / weapon card
  get ammoTxt() { return getEl<HTMLDivElement>('ammoTxt'); },
  get ammoMax() { return getEl<HTMLDivElement>('ammoMax'); },
  get weaponName() { return getEl<HTMLDivElement>('weaponName'); },
  get wcIcon() { return maybeEl<HTMLDivElement>('wcIcon'); },
  get wcMode() { return maybeEl<HTMLDivElement>('wcMode'); },
  get wcReloadHint() { return maybeEl<HTMLDivElement>('wcReloadHint'); },

  // Grenades / Kills / Deaths
  get grenadeTxt() { return getEl<HTMLDivElement>('grenadeTxt'); },
  get killTxt() { return maybeEl<HTMLDivElement>('killTxt'); },
  get deathTxt() { return maybeEl<HTMLDivElement>('deathTxt'); },

  // Weapon slots
  get slot0() { return maybeEl<HTMLDivElement>('slot0'); },
  get slot1() { return maybeEl<HTMLDivElement>('slot1'); },
  get slot2() { return maybeEl<HTMLDivElement>('slot2'); },
  get slot0icon() { return maybeEl<HTMLDivElement>('slot0icon'); },
  get slot1icon() { return maybeEl<HTMLDivElement>('slot1icon'); },
  get slot2icon() { return maybeEl<HTMLDivElement>('slot2icon'); },
  get slot0name() { return maybeEl<HTMLDivElement>('slot0name'); },
  get slot1name() { return maybeEl<HTMLDivElement>('slot1name'); },
  get slot2name() { return maybeEl<HTMLDivElement>('slot2name'); },

  // Overlays
  get dmg() { return getEl<HTMLDivElement>('dmg'); },
  get hlf() { return getEl<HTMLDivElement>('hlf'); },
  get kn() { return getEl<HTMLDivElement>('kn'); },
  get ds() { return getEl<HTMLDivElement>('ds'); },
  get dsp() { return getEl<HTMLParagraphElement>('dsp'); },
  get dsKiller() { return maybeEl<HTMLDivElement>('dsKiller'); },
  get dsWeapon() { return maybeEl<HTMLDivElement>('dsWeapon'); },
  get lockHint() { return getEl<HTMLDivElement>('lockHint'); },

  // Match info
  get miMode() { return maybeEl<HTMLDivElement>('hmMode') ?? maybeEl<HTMLDivElement>('miMode'); },
  get miTime() { return maybeEl<HTMLDivElement>('hmTimer') ?? maybeEl<HTMLDivElement>('miTime'); },
  get miScoreBlue() { return maybeEl<HTMLDivElement>('hmScoreBlue') ?? maybeEl<HTMLDivElement>('miScoreBlue'); },
  get miScoreRed() { return maybeEl<HTMLDivElement>('hmScoreRed') ?? maybeEl<HTMLDivElement>('miScoreRed'); },

  // Legacy fallbacks — resolve to new match-info panel if old elements aren't present
  get sbBlue() { return maybeEl<HTMLDivElement>('sbBlue') ?? getEl<HTMLDivElement>('hmScoreBlue'); },
  get sbRed() { return maybeEl<HTMLDivElement>('sbRed') ?? getEl<HTMLDivElement>('hmScoreRed'); },
  get sbMid() { return maybeEl<HTMLDivElement>('sbMid') ?? getEl<HTMLDivElement>('hmTimer'); },

  // Compass
  get compassStrip() { return maybeEl<HTMLDivElement>('compassStrip'); },

  // Crosshair feedback
  get xhHit() { return maybeEl<HTMLDivElement>('xhHit'); },
  get xhKill() { return maybeEl<HTMLDivElement>('xhKill'); },
  get xhReload() { return maybeEl<HTMLDivElement>('xhReload'); },
  get xhReloadFill() { return maybeSvg<SVGCircleElement>('xhReloadFill'); },

  // Damage arcs
  get dmgArcs() { return maybeEl<HTMLDivElement>('dmgArcs'); },

  // Minimap
  get mmCanvas() { return getEl<HTMLCanvasElement>('mmCanvas'); },
  get mmCoords() { return maybeEl<HTMLDivElement>('mmCoords'); },
  get mmObjectives() { return maybeEl<HTMLDivElement>('mmObjectives'); },

  // Menus
  get mainMenu() { return maybeEl<HTMLDivElement>('mainMenuRoot') ?? getEl<HTMLDivElement>('mainMenu'); },
  get modeSelect() { return getEl<HTMLSelectElement>('modeSelect'); },
  get classSelect() { return getEl<HTMLSelectElement>('classSelect'); },
  get startBtn() { return getEl<HTMLButtonElement>('startBtn'); },
  get pauseMenu() { return maybeEl<HTMLDivElement>('pauseDrawer') ?? getEl<HTMLDivElement>('pauseMenu'); },
  get pauseResume() { return maybeEl<HTMLButtonElement>('pauseResume') ?? (document.querySelector('#pauseDrawer [data-action="resume"]') as HTMLButtonElement | null) ?? getEl<HTMLButtonElement>('pauseResume'); },
  get pauseSettings() { return maybeEl<HTMLButtonElement>('pauseSettings') ?? (document.querySelector('#pauseDrawer [data-action="settings"]') as HTMLButtonElement | null) ?? getEl<HTMLButtonElement>('pauseSettings'); },
  get pauseRestart() { return maybeEl<HTMLButtonElement>('pauseRestart') ?? (document.querySelector('#pauseDrawer [data-action="restart"]') as HTMLButtonElement | null) ?? getEl<HTMLButtonElement>('pauseRestart'); },
  get pauseQuit() { return maybeEl<HTMLButtonElement>('pauseQuit') ?? (document.querySelector('#pauseDrawer [data-action="quit"]') as HTMLButtonElement | null) ?? getEl<HTMLButtonElement>('pauseQuit'); },

  // Settings
  get settingsMenu() { return getEl<HTMLDivElement>('settingsMenu'); },
  get setSensitivity() { return getEl<HTMLInputElement>('setSensitivity'); },
  get setFOV() { return getEl<HTMLInputElement>('setFOV'); },
  get setMasterVol() { return getEl<HTMLInputElement>('setMasterVol'); },
  get setSfxVol() { return getEl<HTMLInputElement>('setSfxVol'); },
  get setMusicVol() { return getEl<HTMLInputElement>('setMusicVol'); },
  get settingsBack() { return getEl<HTMLButtonElement>('settingsBack'); },
  get valSens() { return getEl<HTMLSpanElement>('valSens'); },
  get valFOV() { return getEl<HTMLSpanElement>('valFOV'); },
  get valMasterVol() { return getEl<HTMLSpanElement>('valMasterVol'); },
  get valSfxVol() { return getEl<HTMLSpanElement>('valSfxVol'); },
  get valMusicVol() { return getEl<HTMLSpanElement>('valMusicVol'); },
  get setHeadBob() { return getEl<HTMLInputElement>('setHeadBob'); },
  get valHeadBob() { return getEl<HTMLSpanElement>('valHeadBob'); },

  // New settings
  get setCrosshairColor() { return getEl<HTMLInputElement>('setCrosshairColor'); },
  get valCrosshairColor() { return getEl<HTMLSpanElement>('valCrosshairColor'); },
  get setCrosshairSize() { return getEl<HTMLInputElement>('setCrosshairSize'); },
  get valCrosshairSize() { return getEl<HTMLSpanElement>('valCrosshairSize'); },
  get setCrosshairDot() { return getEl<HTMLInputElement>('setCrosshairDot'); },
  get setBotDifficulty() { return getEl<HTMLInputElement>('setBotDifficulty'); },
  get valBotDifficulty() { return getEl<HTMLSpanElement>('valBotDifficulty'); },
  get setColorblind() { return getEl<HTMLSelectElement>('setColorblind'); },
  get setShowFPS() { return getEl<HTMLInputElement>('setShowFPS'); },
  get setShowSubtitles() { return getEl<HTMLInputElement>('setShowSubtitles'); },

  // FPS counter
  get fpsCounter() { return maybeEl<HTMLDivElement>('fpsCounter'); },

  // Loading screen
  get loadingScreen() { return maybeEl<HTMLDivElement>('loadingScreen'); },
  get lsFill() { return maybeEl<HTMLDivElement>('lsFill'); },
  get lsText() { return maybeEl<HTMLDivElement>('lsText'); },

  // Subtitle overlay
  get subtitleOverlay() { return maybeEl<HTMLDivElement>('subtitleOverlay'); },

  // Killstreak
  get killstreak() { return getEl<HTMLDivElement>('killstreak'); },

  // Killfeed + reload
  get killfeed() { return getEl<HTMLDivElement>('killfeed'); },
  get reloadBar() { return getEl<HTMLDivElement>('reloadBar'); },
  get reloadFill() { return getEl<HTMLDivElement>('reloadFill'); },
  get reloadText() { return getEl<HTMLDivElement>('reloadText'); },

  // Tab scoreboard
  get tabboard() { return getEl<HTMLDivElement>('tabboard'); },
  get tbBody() { return getEl<HTMLDivElement>('tbBody'); },

  // Round summary
  get roundSummary() { return getEl<HTMLDivElement>('roundSummary'); },
  get rsResult() { return getEl<HTMLDivElement>('rsResult'); },
  get rsTeamScore() { return getEl<HTMLDivElement>('rsTeamScore'); },
  get rsMvp() { return getEl<HTMLDivElement>('rsMvp'); },
  get rsPodium() { return getEl<HTMLDivElement>('rsPodium'); },
  get rsStats() { return getEl<HTMLDivElement>('rsStats'); },
  get rsBtn() { return getEl<HTMLButtonElement>('rsBtn'); },
};
