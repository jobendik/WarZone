import { gameState } from '@/core/GameState';
import { TEAM_BLUE, TEAM_RED } from '@/config/constants';
import type { TDMAgent } from '@/entities/TDMAgent';

/**
 * Scoreboard — TAB-held standings table.
 *
 * Writes preview-shape rows into #tbBody:
 *   <div class="tb-row me|blue|red">
 *     <span class="tb-name">JO_VANGUARD</span>
 *     <span>24</span><span>7</span><span>3</span>
 *     <span>3.43</span><span>3,840</span>
 *   </div>
 *
 * The .me row gets the amber left-accent; .blue / .red color the name
 * cell cyan or hazard.
 *
 * Public API preserved:
 *   updateScoreboard()  — called from main.ts + GameLoop
 *   showScoreboard()
 *   hideScoreboard()
 */

let tbEl: HTMLElement | null = null;
let tbBody: HTMLElement | null = null;
let lastRows: string = '';   // dumb diffing — avoid innerHTML thrash

function cache(): void {
  if (!tbEl)   tbEl   = document.getElementById('tabboard');
  if (!tbBody) tbBody = document.getElementById('tbBody');
}

interface Row {
  name: string;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  team: number;
  isPlayer: boolean;
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  const player = gameState.player;

  // Player row
  if (player) {
    rows.push({
      name:    player.name ?? 'YOU',
      kills:   gameState.pKills ?? 0,
      deaths:  gameState.pDeaths ?? 0,
      assists: gameState.pAssists ?? 0,
      score:   gameState.pScore ?? 0,
      team:    player.team ?? TEAM_BLUE,
      isPlayer: true,
    });
  }

  // Bots
  for (const ag of (gameState.agents ?? [] as TDMAgent[])) {
    if (!ag || ag === player) continue;
    rows.push({
      name:    ag.name ?? '—',
      kills:   ag.kills ?? 0,
      deaths:  ag.deaths ?? 0,
      assists: ag.assists ?? 0,
      score:   (ag as any).score ?? (ag.kills ?? 0) * 100,
      team:    ag.team ?? TEAM_BLUE,
      isPlayer: false,
    });
  }

  // Sort: by score desc, then kills desc
  rows.sort((a, b) => (b.score - a.score) || (b.kills - a.kills));
  return rows;
}

function kdText(k: number, d: number): string {
  if (d === 0) return k > 0 ? k.toFixed(2) : '—';
  return (k / d).toFixed(2);
}

function rowHTML(r: Row): string {
  const classes = ['tb-row'];
  if (r.isPlayer)             classes.push('me');
  if (r.team === TEAM_BLUE)   classes.push('blue');
  else if (r.team === TEAM_RED) classes.push('red');

  return (
    `<div class="${classes.join(' ')}">` +
      `<span class="tb-name">${escapeHTML(r.name)}</span>` +
      `<span>${r.kills}</span>` +
      `<span>${r.deaths}</span>` +
      `<span>${r.assists}</span>` +
      `<span>${kdText(r.kills, r.deaths)}</span>` +
      `<span>${r.score.toLocaleString()}</span>` +
    `</div>`
  );
}

export function updateScoreboard(): void {
  cache();
  if (!tbBody) return;
  const rows = buildRows();
  const html = rows.map(rowHTML).join('');
  if (html !== lastRows) {
    tbBody.innerHTML = html;
    lastRows = html;
  }
}

export function showScoreboard(): void {
  cache();
  if (tbEl) tbEl.classList.add('on');
  updateScoreboard();
}
export function hideScoreboard(): void {
  cache();
  if (tbEl) tbEl.classList.remove('on');
}
export function toggleScoreboard(): void {
  cache();
  if (!tbEl) return;
  if (tbEl.classList.contains('on')) hideScoreboard();
  else showScoreboard();
}

function escapeHTML(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}
