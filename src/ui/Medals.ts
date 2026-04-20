import { gameState } from '@/core/GameState';
import { announce } from './Announcer';
import { fireChallengeEvent } from './Challenges';
import { playMedalSound } from '@/audio/SoundHooks';
import type { TDMAgent } from '@/entities/TDMAgent';
import { GLYPHS } from './Glyphs';

export type MedalId =
  | 'first_blood' | 'headshot' | 'long_shot' | 'point_blank'
  | 'revenge' | 'clutch' | 'savior' | 'multi_kill'
  | 'triple_kill' | 'quad_kill' | 'ace' | 'knife_kill'
  | 'execution' | 'nade_kill' | 'rocket_kill' | 'collateral';

interface MedalDef {
  name: string;
  xp: number;
  color: string;
  tier: 'bronze' | 'silver' | 'gold' | 'epic';
  icon: string; // emoji fallback — swap for <img> when you have real assets
}

export const MEDALS: Record<MedalId, MedalDef> = {
  first_blood:  { name: 'FIRST BLOOD',  xp: 150, color: '#ff3d2e', tier: 'gold',   icon: GLYPHS.medal_drop },
  headshot:     { name: 'HEADSHOT',     xp: 50,  color: '#ff8c1a', tier: 'silver', icon: GLYPHS.medal_crosshair },
  long_shot:    { name: 'LONG SHOT',    xp: 75,  color: '#39f0ff', tier: 'silver', icon: GLYPHS.medal_scope },
  point_blank:  { name: 'POINT BLANK',  xp: 40,  color: '#ffa73a', tier: 'bronze', icon: GLYPHS.medal_explosion },
  revenge:      { name: 'REVENGE',      xp: 60,  color: '#c27bff', tier: 'gold',   icon: GLYPHS.medal_x },
  clutch:       { name: 'CLUTCH',       xp: 150, color: '#ff8c1a', tier: 'epic',   icon: GLYPHS.medal_diamond },
  savior:       { name: 'SAVIOR',       xp: 80,  color: '#b8ff3d', tier: 'silver', icon: GLYPHS.medal_shield },
  multi_kill:   { name: 'DOUBLE KILL',  xp: 100, color: '#ffa73a', tier: 'silver', icon: GLYPHS.medal_double },
  triple_kill:  { name: 'TRIPLE KILL',  xp: 200, color: '#ff8c1a', tier: 'gold',   icon: GLYPHS.medal_triple },
  quad_kill:    { name: 'QUAD KILL',    xp: 350, color: '#ff3d2e', tier: 'epic',   icon: GLYPHS.medal_quad },
  ace:          { name: 'ACE',          xp: 500, color: '#ff8c1a', tier: 'epic',   icon: GLYPHS.medal_star },
  knife_kill:   { name: 'HUMILIATION',  xp: 100, color: '#6d7689', tier: 'gold',   icon: GLYPHS.medal_blade },
  execution:    { name: 'EXECUTION',    xp: 35,  color: '#3f4758', tier: 'bronze', icon: GLYPHS.medal_x },
  nade_kill:    { name: 'FRAG OUT',     xp: 60,  color: '#b8ff3d', tier: 'silver', icon: GLYPHS.medal_explosion },
  rocket_kill:  { name: 'DIRECT HIT',   xp: 75,  color: '#ffa73a', tier: 'silver', icon: GLYPHS.medal_rocket },
  collateral:   { name: 'COLLATERAL',   xp: 100, color: '#c27bff', tier: 'gold',   icon: GLYPHS.medal_double_circle },
};

interface MedalTickerItem {
  medal: MedalId;
  element: HTMLDivElement;
  life: number;
}

const tickerActive: MedalTickerItem[] = [];
let tickerEl: HTMLDivElement | null = null;

// Per-match state
export const matchState = {
  playerXP: 0,
  medalsEarned: [] as { medal: MedalId; at: number }[],
  firstBloodTaken: false,
  playerKillTimes: [] as number[],   // timestamps of player kills (for multi-kill detection)
  lastKilledBy: null as TDMAgent | null,
};

function ensureTicker(): HTMLDivElement {
  if (tickerEl) return tickerEl;
  tickerEl = document.createElement('div');
  tickerEl.id = 'medalTicker';
  document.body.appendChild(tickerEl);
  return tickerEl;
}

export function awardMedal(id: MedalId): void {
  const def = MEDALS[id];
  matchState.playerXP += def.xp;
  matchState.medalsEarned.push({ medal: id, at: gameState.worldElapsed });
  fireChallengeEvent({ type: 'medal', id });
  playMedalSound(def.tier);

  if (id === 'multi_kill') import('@/audio/AudioManager').then(({ Audio }) => Audio.play('announcer_double_kill'));
  if (id === 'triple_kill') import('@/audio/AudioManager').then(({ Audio }) => Audio.play('announcer_triple_kill'));
  if (id === 'quad_kill' || id === 'ace') import('@/audio/AudioManager').then(({ Audio }) => Audio.play('announcer_overkill'));

  const ticker = ensureTicker();
  const item = document.createElement('div');
  item.className = `medal-item medal-${def.tier}`;
  item.style.borderColor = def.color;
  item.innerHTML = `
    <div class="medal-icon" style="color:${def.color};width:28px;height:28px;display:flex;align-items:center;justify-content:center">${def.icon}</div>
    <div class="medal-meta">
      <div class="medal-name" style="color:${def.color}">${def.name}</div>
      <div class="medal-xp">+${def.xp} XP</div>
    </div>
  `;
  ticker.appendChild(item);

  // Tier-appropriate announcer
  if (def.tier === 'epic') {
    announce(def.name, { tier: 'large', color: def.color, sub: `+${def.xp} XP`, duration: 2.4 });
  } else if (def.tier === 'gold') {
    announce(def.name, { tier: 'medium', color: def.color, duration: 1.4 });
  }

  tickerActive.push({ medal: id, element: item, life: 3.5 });
}

export function updateMedalTicker(dt: number): void {
  for (let i = tickerActive.length - 1; i >= 0; i--) {
    const t = tickerActive[i];
    t.life -= dt;
    if (t.life <= 0) {
      t.element.classList.add('fade-out');
      setTimeout(() => t.element.remove(), 400);
      tickerActive.splice(i, 1);
    }
  }
}

/**
 * Main entry point — call this when the player gets a kill. Decides which
 * medals to award based on context.
 */
export function onPlayerKill(victim: TDMAgent, distance: number, weaponId: string, isHeadshot: boolean): void {
  const now = gameState.worldElapsed;
  matchState.playerKillTimes.push(now);

  // First blood (first kill of the match by anyone)
  const anyKillYet = gameState.killfeedEntries.length > 0;
  if (!matchState.firstBloodTaken && !anyKillYet) {
    matchState.firstBloodTaken = true;
    awardMedal('first_blood');
  }

  // Revenge — victim was our last killer within 30s
  const lastDeathTime = (gameState as any)._lastPlayerDeathTime;
  if (matchState.lastKilledBy === victim && typeof lastDeathTime === 'number' && now - lastDeathTime < 30) {
    awardMedal('revenge');
    matchState.lastKilledBy = null;
  }

  // Weapon-specific
  if (weaponId === 'knife') awardMedal('knife_kill');
  else if (weaponId === 'rocket_launcher') awardMedal('rocket_kill');

  // Range
  if (isHeadshot) awardMedal('headshot');
  if (distance > 45) awardMedal('long_shot');
  else if (distance < 4 && weaponId !== 'knife') awardMedal('point_blank');

  // Multi-kill: 2+ kills in 4 seconds
  const recent = matchState.playerKillTimes.filter(t => now - t < 4);
  if (recent.length >= 5) awardMedal('ace');
  else if (recent.length === 4) awardMedal('quad_kill');
  else if (recent.length === 3) awardMedal('triple_kill');
  else if (recent.length === 2) awardMedal('multi_kill');

  // Base XP for the kill itself
  matchState.playerXP += 100;
}

export function onPlayerDeath(killer: TDMAgent | null): void {
  matchState.lastKilledBy = killer;
  (gameState as any)._lastPlayerDeathTime = gameState.worldElapsed;
}

export function resetMatchMedals(): void {
  matchState.playerXP = 0;
  matchState.medalsEarned.length = 0;
  matchState.firstBloodTaken = false;
  matchState.playerKillTimes.length = 0;
  matchState.lastKilledBy = null;
  if (tickerEl) tickerEl.innerHTML = '';
  tickerActive.length = 0;
}