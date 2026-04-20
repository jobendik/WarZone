import { gameState } from '@/core/GameState';
import { getProfile, getXpProgress } from '@/core/PlayerProfile';
import { matchState, MEDALS, type MedalId } from './Medals';
import { GLYPHS } from './Glyphs';
import { TEAM_BLUE, TEAM_RED } from '@/config/constants';
import type { TDMAgent } from '@/entities/TDMAgent';

/**
 * RoundSummary — APEX PROTOCOL post-match screen.
 *
 * Emits the preview's .vc-* shell into #roundSummary:
 *   .vc-shell
 *     .vc-banner       (VICTORY / DEFEAT gradient + final score)
 *     .vc-mvp          (MVP slate with amber left accent)
 *     .vc-body (2col)
 *       Left:  PROGRESSION card + ACCOLADES medal grid
 *       Right: FINAL STANDINGS table
 *     .vc-footer       (▶ NEXT MATCH, RETURN TO LOBBY, hint)
 *
 * Public API — two call signatures accepted for backward compatibility
 * with Combat.ts which passes a team id:
 *
 *   showRoundSummary(winnerTeam)        legacy — TEAM_BLUE or TEAM_RED number
 *   showRoundSummary(resultObject)      structured — { victory, mode, ... }
 *
 * Both produce the same victory/defeat screen.
 *
 * Score model — gameState has no pScore field and TDMAgent has no
 * `assists`/`score`. We synthesize:  score = kills * 100 + assists * 25.
 */

export interface RoundSummaryResult {
  victory: boolean;
  mode: string;
  map: string;
  blueScore: number;
  redScore: number;
  xpAwarded: number;
}

export interface RoundSummaryCallbacks {
  onNextMatch?: () => void;
  onReturnToLobby?: () => void;
}

let rootEl: HTMLDivElement | null = null;
let cbs: RoundSummaryCallbacks = {};
let open = false;
let keyListener: ((e: KeyboardEvent) => void) | null = null;

// ── Helpers ────────────────────────────────────────────────────────────
function scoreFromKills(kills: number, assists: number): number {
  return kills * 100 + assists * 25;
}

function teamScoresFromGameState(): { blue: number; red: number } {
  const ts = (gameState as any).teamScores as number[] | undefined;
  return {
    blue: ts?.[TEAM_BLUE] ?? 0,
    red:  ts?.[TEAM_RED]  ?? 0,
  };
}

function aggregateMedals(): Array<{ id: MedalId; count: number }> {
  const counts = new Map<MedalId, number>();
  for (const entry of matchState.medalsEarned) {
    counts.set(entry.medal, (counts.get(entry.medal) ?? 0) + 1);
  }
  const arr = Array.from(counts.entries()).map(([id, count]) => ({ id, count }));
  const tierOrder = { epic: 0, gold: 1, silver: 2, bronze: 3 };
  arr.sort((a, b) => {
    const ta = tierOrder[MEDALS[a.id].tier];
    const tb = tierOrder[MEDALS[b.id].tier];
    return ta - tb || b.count - a.count;
  });
  return arr;
}

// Pick MVP — highest-score agent on either team
function computeMVP(): {
  name: string; team: number; isPlayer: boolean;
  kills: number; deaths: number; assists: number; score: number;
} {
  const player = gameState.player;
  const pKills   = gameState.pKills   ?? 0;
  const pDeaths  = gameState.pDeaths  ?? 0;
  const pAssists = gameState.pAssists ?? 0;

  const playerRow = {
    name:    player?.name ?? 'OPERATOR',
    team:    (player?.team as number) ?? TEAM_BLUE,
    isPlayer: true,
    kills:   pKills,
    deaths:  pDeaths,
    assists: pAssists,
    score:   scoreFromKills(pKills, pAssists),
  };

  let best = playerRow;
  for (const ag of (gameState.agents ?? []) as TDMAgent[]) {
    if (!ag || ag === player) continue;
    const kills  = ag.kills  ?? 0;
    const deaths = ag.deaths ?? 0;
    const score  = scoreFromKills(kills, 0);   // bots have no assists tracker
    if (score > best.score) {
      best = {
        name:   ag.name ?? '—',
        team:   (ag.team as number) ?? TEAM_BLUE,
        isPlayer: false,
        kills, deaths, assists: 0, score,
      };
    }
  }
  return best;
}

function buildStandingsRows(): Array<{
  rank: number; name: string; team: number; isPlayer: boolean;
  kills: number; deaths: number; score: number;
}> {
  const player = gameState.player;
  const rows: Array<{
    name: string; team: number; isPlayer: boolean;
    kills: number; deaths: number; score: number;
  }> = [];

  if (player) {
    const kills   = gameState.pKills   ?? 0;
    const deaths  = gameState.pDeaths  ?? 0;
    const assists = gameState.pAssists ?? 0;
    rows.push({
      name:    player.name ?? 'YOU',
      team:    (player.team as number) ?? TEAM_BLUE,
      isPlayer: true,
      kills, deaths,
      score:   scoreFromKills(kills, assists),
    });
  }
  for (const ag of (gameState.agents ?? []) as TDMAgent[]) {
    if (!ag || ag === player) continue;
    const kills  = ag.kills  ?? 0;
    const deaths = ag.deaths ?? 0;
    rows.push({
      name:   ag.name ?? '—',
      team:   (ag.team as number) ?? TEAM_BLUE,
      isPlayer: false,
      kills, deaths,
      score:  scoreFromKills(kills, 0),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 6).map((r, i) => ({ ...r, rank: i + 1 }));
}

// ── Normalise argument ─────────────────────────────────────────────────
/**
 * Accept either:
 *   - legacy `showRoundSummary(winnerTeam: number)`
 *       where number is TEAM_BLUE (0) or TEAM_RED (1)
 *   - structured `showRoundSummary(result: RoundSummaryResult)`
 *
 * Legacy path synthesises mode/map/scores from gameState.
 */
function normalizeArg(arg: RoundSummaryResult | number): RoundSummaryResult {
  if (typeof arg === 'number') {
    const winnerTeam = arg;
    const playerTeam = (gameState.player?.team as number) ?? TEAM_BLUE;
    const scores = teamScoresFromGameState();
    return {
      victory:    winnerTeam === playerTeam,
      mode:       String(gameState.mode ?? 'TDM').toUpperCase(),
      map:        (gameState as any).mapName ?? 'WARZONE',
      blueScore:  scores.blue,
      redScore:   scores.red,
      xpAwarded:  matchState.playerXP ?? 0,
    };
  }
  return arg;
}

// ── Render ─────────────────────────────────────────────────────────────
function render(result: RoundSummaryResult): string {
  const profile = getProfile();
  const xp = getXpProgress();
  const pctInLevel = xp.needed > 0 ? (xp.current / xp.needed) * 100 : 100;
  const mvp = computeMVP();
  const mvpIsYou = mvp.isPlayer;
  const standings = buildStandingsRows();
  const medals = aggregateMedals();

  const resultCls = result.victory ? '' : 'defeat';
  const resultText = result.victory ? 'VICTORY' : 'DEFEAT';
  const kicker = `// MATCH CONCLUDED · ${result.map.toUpperCase()}`;
  const playerTeam = (gameState.player?.team as number) ?? TEAM_BLUE;
  const friendlyScore = playerTeam === TEAM_RED ? result.redScore : result.blueScore;
  const hostileScore  = playerTeam === TEAM_RED ? result.blueScore : result.redScore;

  const medalsHTML = medals.length > 0
    ? medals.map(({ id, count }) => {
        const def = MEDALS[id];
        const glyph = GLYPHS[def.glyph] ?? '';
        return (
          `<div class="vc-medal ${def.tier}">` +
            `<div class="vc-medal-ico">${glyph}</div>` +
            `<div class="vc-medal-name">${escapeHTML(def.name)}</div>` +
            (count > 1 ? `<div class="vc-medal-count">×${count}</div>` : '') +
          `</div>`
        );
      }).join('')
    : '<div style="padding:20px;color:var(--mute);font-family:var(--f-num);font-size:11px;letter-spacing:.2em">NO MEDALS EARNED</div>';

  const standingsHTML = standings.map((r) => {
    const rowClasses = ['vc-st-row'];
    if (r.isPlayer) rowClasses.push('me');
    const nameCls = r.team === TEAM_BLUE ? 'friendly' : r.team === TEAM_RED ? 'hostile' : '';
    return (
      `<div class="${rowClasses.join(' ')}">` +
        `<span class="vc-st-rank">${String(r.rank).padStart(2, '0')}</span>` +
        `<span class="vc-st-name ${nameCls}">${escapeHTML(r.name)}</span>` +
        `<span class="vc-st-kd">${r.kills}</span>` +
        `<span class="vc-st-kd">${r.deaths}</span>` +
        `<span class="vc-st-score">${r.score.toLocaleString()}</span>` +
      `</div>`
    );
  }).join('');

  const newLevel = profile.level;
  const oldLevel = Math.max(1, newLevel - (xp.current < result.xpAwarded ? 1 : 0));
  const leveledUp = newLevel > oldLevel;

  return `
    <div class="arena-bg"></div>

    <div class="vc-shell">

      <div class="vc-banner">
        <div class="vc-result-wrap">
          <div class="vc-result-kicker">${escapeHTML(kicker)}</div>
          <div class="vc-result ${resultCls}">${resultText}</div>
        </div>
        <div class="vc-score-block">
          <div class="vc-score-row">
            <span class="f">${friendlyScore}</span>
            <span class="sep">/</span>
            <span class="h">${hostileScore}</span>
          </div>
          <div class="vc-score-label">${escapeHTML(result.mode.toUpperCase())} · ${escapeHTML(result.map.toUpperCase())}</div>
        </div>
      </div>

      <div class="vc-mvp">
        <div class="vc-mvp-tag">★</div>
        <div>
          <div class="vc-mvp-name-row">${mvpIsYou ? 'MVP — YOU' : `MVP — ${escapeHTML(mvp.name)}`}</div>
          <div class="vc-mvp-stats">
            <span>KILLS <b>${mvp.kills}</b></span>
            <span>DEATHS <b>${mvp.deaths}</b></span>
            <span>K/D <b>${mvp.deaths === 0 ? mvp.kills.toFixed(2) : (mvp.kills / mvp.deaths).toFixed(2)}</b></span>
            <span>SCORE <b>${mvp.score.toLocaleString()}</b></span>
          </div>
        </div>
        <div class="vc-mvp-xp">+${result.xpAwarded.toLocaleString()} XP</div>
      </div>

      <div class="vc-body">
        <div>
          <div class="vc-section-head">PROGRESSION</div>
          <div class="vc-progress-card">
            <div class="vc-prog-row">
              <div class="vc-lvl-badge">${oldLevel}</div>
              <div>
                <div class="vc-xp-rail" style="--xp-pct:${pctInLevel.toFixed(1)}%"></div>
                <div class="vc-xp-meta">
                  <span>LVL ${newLevel} · ${xp.current.toLocaleString()} XP</span>
                  <span><b>+${result.xpAwarded.toLocaleString()}</b> → LVL ${newLevel + 1}</span>
                </div>
              </div>
              <div class="vc-lvl-badge ${leveledUp ? 'new' : ''}">${newLevel + (leveledUp ? 1 : 0)}</div>
            </div>
          </div>

          <div class="vc-section-head">ACCOLADES</div>
          <div class="vc-medals">${medalsHTML}</div>
        </div>

        <div>
          <div class="vc-section-head">FINAL STANDINGS</div>
          <div class="vc-standings">
            <div class="vc-st-head">
              <span>#</span><span>OPERATOR</span><span>K</span><span>D</span><span>SCORE</span>
            </div>
            ${standingsHTML}
          </div>
        </div>
      </div>

      <div class="vc-footer">
        <button class="vc-btn-primary" id="vcNext">▶ NEXT MATCH</button>
        <button class="vc-btn-secondary" id="vcLobby">RETURN TO LOBBY</button>
        <span class="vc-hint">[SPACE] CONTINUE · [TAB] EXTENDED SCORECARD</span>
      </div>

    </div>
  `;
}

// ── Public API ─────────────────────────────────────────────────────────
export function initRoundSummary(callbacks: RoundSummaryCallbacks = {}): void {
  cbs = { ...cbs, ...callbacks };
}

/**
 * Show the post-match summary.  Accepts both the legacy team-id form
 * (from Combat.ts:  showRoundSummary(TEAM_BLUE)) and the structured
 * form (from main.ts when richer data is available).
 */
export function showRoundSummary(arg: RoundSummaryResult | number): void {
  if (!rootEl) rootEl = document.getElementById('roundSummary') as HTMLDivElement;
  if (!rootEl) return;

  const result = normalizeArg(arg);
  rootEl.innerHTML = render(result);
  rootEl.classList.add('on');
  open = true;

  const nextBtn  = rootEl.querySelector('#vcNext')  as HTMLButtonElement | null;
  const lobbyBtn = rootEl.querySelector('#vcLobby') as HTMLButtonElement | null;
  nextBtn?.addEventListener('click',  () => { hideRoundSummary(); cbs.onNextMatch?.(); });
  lobbyBtn?.addEventListener('click', () => { hideRoundSummary(); cbs.onReturnToLobby?.(); });

  if (!keyListener) {
    keyListener = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.code === 'Space')  { e.preventDefault(); hideRoundSummary(); cbs.onNextMatch?.(); }
      if (e.code === 'Escape') { e.preventDefault(); hideRoundSummary(); cbs.onReturnToLobby?.(); }
    };
    window.addEventListener('keydown', keyListener, true);
  }

  document.exitPointerLock?.();
}

export function hideRoundSummary(): void {
  if (rootEl) rootEl.classList.remove('on');
  open = false;
}

export function isRoundSummaryOpen(): boolean { return open; }

function escapeHTML(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}
