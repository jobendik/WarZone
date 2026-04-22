/**
 * MainMenu — APEX PROTOCOL career-style boot UI.
 *
 * Three-column editorial layout: operator (L) · play (C) · intel (R)
 * Six tabs along the top: PLAY · LOADOUT · CAREER · CONTRACTS · COSMETICS · SETTINGS
 *
 * ALL styling lives in src/styles/index.css.  This file only builds
 * the DOM and wires events — the old 700-line `injectStyles()` function
 * has been removed.  If something looks wrong visually, edit index.css;
 * if something behaves wrong, edit here.
 *
 * Public API (unchanged):
 *   initMainMenu(onStart, onTraining)
 *   showMainMenu()
 *   hideMainMenu()
 */

import {
  getProfile, subscribeProfile, getXpProgress, getOverallKD, getWinRate,
  MAX_LEVEL, prestige,
} from '@/core/PlayerProfile';
import { gameState } from '@/core/GameState';
import {
  getLoadouts, setActiveLoadout, updateLoadout,
  PERKS, FIELD_UPGRADES, LETHALS, TACTICALS,
} from '@/config/Loadouts';
import { getContracts, claimAllCompleted, getActiveContractCount } from './ContractSystem';
import { bindSettingsPanel } from './Settings';
import type { GameMode } from '@/core/GameModes';

// ─────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────

type Tab = 'play' | 'career' | 'loadout' | 'contracts' | 'cosmetics' | 'settings';

interface MenuState {
  visible: boolean;
  activeTab: Tab;
  selectedMode: GameMode;
  editingLoadoutIndex: number;
  onStart: ((mode: GameMode, loadoutIndex: number) => void) | null;
  onTraining: (() => void) | null;
  container: HTMLDivElement | null;
  unsubscribe: (() => void) | null;
}

const state: MenuState = {
  visible: false,
  activeTab: 'play',
  selectedMode: 'tdm',
  editingLoadoutIndex: 0,
  onStart: null,
  onTraining: null,
  container: null,
  unsubscribe: null,
};

// ─────────────────────────────────────────────────────────────────────
//  MODE DEFINITIONS — 6 primary modes in a 3×2 grid
// ─────────────────────────────────────────────────────────────────────

const MODES: Array<{ id: GameMode; name: string; subtitle: string; players: string; icon: string }> = [
  {
    id: 'tdm', name: 'TEAM DM',
    subtitle: 'Classic team deathmatch — first to 20 eliminations.',
    players: '6V6 · 7 MIN',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
  },
  {
    id: 'domination', name: 'DOMINATION',
    subtitle: 'Capture and hold 3 zones. First to 200 points wins.',
    players: '6V6 · 10 MIN',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`,
  },
  {
    id: 'hardpoint', name: 'HARDPOINT',
    subtitle: 'Hold the rotating zone to score. Defend aggressively.',
    players: '6V6 · 10 MIN',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12,3 22,20 2,20"/></svg>`,
  },
  {
    id: 'sd', name: 'SEARCH &amp; DESTROY',
    subtitle: 'Plant, defuse, or eliminate. No respawns.',
    players: '5V5 · BO11',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="square"/></svg>`,
  },
  {
    id: 'ctf', name: 'CAPTURE FLAG',
    subtitle: 'Retrieve the enemy flag and bring it back to base.',
    players: '6V6 · 12 MIN',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z"/></svg>`,
  },
  {
    id: 'ffa', name: 'FREE FOR ALL',
    subtitle: 'Every player for themselves — no teams, no mercy.',
    players: '8P · 8 MIN',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="7" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
  },
  {
    id: 'br', name: 'BATTLE ROYALE',
    subtitle: 'Drop in, loot up, be the last one standing.',
    players: '1P · 15 MIN',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2 L12 10"/><path d="M6 6 Q12 14 18 6"/><circle cx="12" cy="18" r="3"/><path d="M12 15 L12 10"/></svg>`,
  },
];

// ─────────────────────────────────────────────────────────────────────
//  LEFT COLUMN — operator portrait + stats + XP rail
// ─────────────────────────────────────────────────────────────────────

function renderLeftCol(): string {
  const p = getProfile();
  const xp = getXpProgress();
  const pctToNext = xp.needed > 0 ? (xp.current / xp.needed) * 100 : 100;
  const kd = getOverallKD().toFixed(2);
  const wr = (getWinRate() * 100).toFixed(1);
  const tier = Math.min(5, Math.floor(p.level / 10) + 1);
  const initials = p.playerName.substring(0, 2).toUpperCase();
  const xpToNext = (xp.needed - xp.current).toLocaleString();

  return `
    <div class="mn-col-head">
      <span class="mn-col-head-text">OPERATOR</span>
      <span class="mn-col-head-id">// LVL-${String(p.level).padStart(3, '0')}</span>
    </div>

    <div class="mn-op-card br4">
      <span class="br-tr"></span><span class="br-bl"></span>
      <div class="mn-op-figure">
        <span class="mn-op-rank-chip">TIER ${tier}</span>
        <svg class="mn-op-silhouette" viewBox="0 0 100 180">
          <path fill="#1a1f2e" stroke="#ff8c1a" stroke-width="0.5" stroke-opacity="0.6"
            d="M50 10 Q30 12 28 32 Q26 42 28 50 Q22 52 22 58 L24 70 L30 75
               L32 90 L20 100 L18 130 L22 170 L40 175 L40 140 L45 175 L55 175
               L60 140 L60 175 L78 170 L82 130 L80 100 L68 90 L70 75 L76 70
               L78 58 Q78 52 72 50 Q74 42 72 32 Q70 12 50 10 Z"/>
          <rect x="34" y="80" width="10" height="14" fill="none" stroke="#ff8c1a" stroke-width="0.3" stroke-opacity="0.5"/>
          <rect x="56" y="80" width="10" height="14" fill="none" stroke="#ff8c1a" stroke-width="0.3" stroke-opacity="0.5"/>
          <path d="M36 28 L64 28 L62 36 L38 36 Z" fill="#ff8c1a" opacity="0.4"/>
          <text x="50" y="135" text-anchor="middle" font-size="18" font-family="monospace" fill="#ff8c1a" opacity="0.9">${initials}</text>
        </svg>
      </div>
      <div class="mn-op-name">${p.playerName}</div>
      <div class="mn-op-callsign">// CALLSIGN: ${p.playerName.toUpperCase()}-${String(p.level).padStart(2, '0')}</div>
    </div>

    <div class="mn-statgrid">
      <div class="mn-stat">
        <div class="mn-stat-label">K/D</div>
        <div class="mn-stat-val acc">${kd}</div>
      </div>
      <div class="mn-stat">
        <div class="mn-stat-label">WINS</div>
        <div class="mn-stat-val">${p.career.totalWins ?? 0}</div>
      </div>
      <div class="mn-stat">
        <div class="mn-stat-label">KILLS</div>
        <div class="mn-stat-val">${(p.career.totalKills ?? 0).toLocaleString()}</div>
      </div>
      <div class="mn-stat">
        <div class="mn-stat-label">WIN %</div>
        <div class="mn-stat-val">${wr}</div>
      </div>
    </div>

    <div class="mn-prog-head">
      <span>LEVEL ${p.level} · ${Math.round(pctToNext)}%</span>
      <b>+${xpToNext} TO ${p.level + 1}</b>
    </div>
    <div class="mn-prog-rail"><div class="mn-prog-fill" style="width:${pctToNext}%"></div></div>
    <div class="mn-prog-sub">SEASON 04 · ${xp.current.toLocaleString()} / ${xp.needed.toLocaleString()} XP</div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  RIGHT COLUMN — INTEL: season news + active contracts
// ─────────────────────────────────────────────────────────────────────

function renderRightCol(): string {
  const dailies = getContracts('daily');
  const active = dailies.filter(c => !c.progress.claimed).slice(0, 3);
  const pendingCount = active.filter(c => c.claimable).length;

  const contractRows = active.map(c => {
    const pct = Math.min(100, (c.progress.progress / c.progress.target) * 100);
    return `
      <div class="mn-contract ${c.claimable ? 'done' : ''}">
        <div class="mn-contract-head">
          <span class="mn-contract-name">${c.def.title}</span>
          <span class="mn-contract-xp">+${c.def.xpReward}</span>
        </div>
        <div class="mn-contract-desc">${c.def.description}</div>
        <div class="mn-contract-rail"><div class="mn-contract-rail-fill" style="width:${pct}%"></div></div>
        <div class="mn-contract-meta">
          <span>${c.progress.progress} / ${c.progress.target}</span>
          <span>${c.claimable ? '▸ CLAIM READY' : 'IN PROGRESS'}</span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="mn-col-head">
      <span class="mn-col-head-text">INTEL</span>
      <span class="mn-col-head-id">${pendingCount > 0 ? `// ${pendingCount} PENDING` : '// UPDATED'}</span>
    </div>

    <div class="mn-news">
      <div class="mn-news-tag">// ACTIVE SEASON</div>
      <div class="mn-news-title">SEASON 04 · WARZONE TDM</div>
      <div class="mn-news-desc">Complete daily contracts to earn season XP and unlock exclusive operator gear.</div>
    </div>

    ${contractRows || `<div class="mn-empty-intel">ALL CONTRACTS CLAIMED</div>`}

    ${pendingCount > 0 ? `
      <button class="mn-claim-btn" id="claimAllBtnRight">CLAIM ALL (${pendingCount})</button>
    ` : ''}
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  CENTER: PLAY TAB — hero slate + 3×2 mode grid + loadout strip + DEPLOY
// ─────────────────────────────────────────────────────────────────────

function renderPlayTab(): string {
  const loadouts = getLoadouts();
  const activeLoadout = loadouts[state.editingLoadoutIndex] || loadouts[0];
  const selectedModeDef = MODES.find(m => m.id === state.selectedMode) ?? MODES[0];

  const modeCards = MODES.map(m => `
    <div class="mn-mode ${state.selectedMode === m.id ? 'on' : ''}" data-mode="${m.id}">
      <div class="mn-mode-row">
        <div class="mn-mode-ico">${m.icon}</div>
        <div class="mn-mode-name">${m.name}</div>
      </div>
      <div class="mn-mode-sub">${m.subtitle}</div>
      <div class="mn-mode-tag">${m.players}</div>
    </div>
  `).join('');

  const loadoutStrip = activeLoadout ? `
    <div class="mn-loadout">
      <div class="mn-loadout-head">
        <span class="mn-loadout-title">ACTIVE LOADOUT</span>
        <span class="mn-loadout-active">${activeLoadout.name}</span>
        <span class="mn-loadout-cycle">TAB · LOADOUT TO EDIT</span>
      </div>
      <div class="mn-loadout-slots">
        <div class="mn-slot primary">
          <div class="mn-slot-label">PRIMARY</div>
          <div class="mn-slot-value">${activeLoadout.primary.replace(/_/g, ' ').toUpperCase()}</div>
        </div>
        <div class="mn-slot">
          <div class="mn-slot-label">SECOND</div>
          <div class="mn-slot-value">${activeLoadout.secondary.replace(/_/g, ' ').toUpperCase()}</div>
        </div>
        <div class="mn-slot">
          <div class="mn-slot-label">LETHAL</div>
          <div class="mn-slot-value">${(activeLoadout.lethal ?? '—').replace(/_/g, ' ').toUpperCase()}</div>
        </div>
        <div class="mn-slot">
          <div class="mn-slot-label">TACT</div>
          <div class="mn-slot-value">${(activeLoadout.tactical ?? '—').replace(/_/g, ' ').toUpperCase()}</div>
        </div>
        <div class="mn-slot">
          <div class="mn-slot-label">FIELD</div>
          <div class="mn-slot-value">${(activeLoadout.fieldUpgrade ?? '—').replace(/_/g, ' ').toUpperCase()}</div>
        </div>
        <div class="mn-slot">
          <div class="mn-slot-label">PERKS</div>
          <div class="mn-slot-value">3/3</div>
        </div>
      </div>
    </div>
  ` : '';

  const isTraining = state.selectedMode === 'training';
  const deployLabel = isTraining ? 'ENTER TRAINING RANGE' : 'INITIATE MATCH';

  return `
    <div class="mn-hero-slate">
      <div class="mn-hero-kicker">// DEPLOYMENT · AVAILABLE NOW</div>
      <div class="mn-hero-title">${selectedModeDef.name}</div>
      <div class="mn-hero-sub">${selectedModeDef.subtitle}</div>
    </div>

    <div class="mn-modes">${modeCards}</div>

    ${loadoutStrip}

    <button class="mn-deploy" id="mmDeploy">
      <div>
        <div class="mn-deploy-kicker">READY FOR DEPLOYMENT</div>
        <div class="mn-deploy-label">${deployLabel}</div>
      </div>
      <div class="mn-deploy-arrow">▸</div>
    </button>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  CENTER: CAREER TAB
// ─────────────────────────────────────────────────────────────────────

function renderCareerTab(): string {
  const p = getProfile();
  const xp = getXpProgress();
  const pctToNext = xp.needed > 0 ? (xp.current / xp.needed) * 100 : 100;
  const careerKD = getOverallKD().toFixed(2);
  const careerWR = (getWinRate() * 100).toFixed(1);
  const hoursPlayed = ((p.career.totalTimePlayed ?? 0) / 3600).toFixed(1);
  const prestigeLevel = p.prestige ?? 0;

  return `
    <div class="mm-career">
      <div class="mm-career-head">
        <div class="mm-avatar">${p.playerName.substring(0, 2).toUpperCase()}</div>
        <div class="mm-career-name">
          <div class="mm-career-username">${p.playerName}</div>
          <div class="mm-career-level">
            <span class="mm-level-pill">${prestigeLevel > 0 ? `P${prestigeLevel} ` : ''}LVL ${p.level}</span>
            <span class="mm-level-sub">${xp.current.toLocaleString()} / ${xp.needed.toLocaleString()} XP</span>
          </div>
          <div class="mm-xp-bar"><div class="mm-xp-fill" style="width:${pctToNext}%"></div></div>
        </div>
      </div>

      ${p.level >= MAX_LEVEL ? `
        <div class="mm-prestige-section">
          <div class="mm-prestige-title">PRESTIGE READY</div>
          <div class="mm-prestige-desc">Reset your level to earn a prestige tier and permanent badge.</div>
          <button class="mm-btn mm-btn-primary" id="prestigeBtn">PRESTIGE</button>
        </div>
      ` : ''}

      <div class="mm-stats-grid">
        <div class="mm-stat"><div class="mm-stat-label">KILLS</div><div class="mm-stat-val">${(p.career.totalKills ?? 0).toLocaleString()}</div></div>
        <div class="mm-stat"><div class="mm-stat-label">DEATHS</div><div class="mm-stat-val">${(p.career.totalDeaths ?? 0).toLocaleString()}</div></div>
        <div class="mm-stat"><div class="mm-stat-label">K/D</div><div class="mm-stat-val">${careerKD}</div></div>
        <div class="mm-stat"><div class="mm-stat-label">WIN RATE</div><div class="mm-stat-val">${careerWR}%</div></div>
        <div class="mm-stat"><div class="mm-stat-label">HEADSHOTS</div><div class="mm-stat-val">${(p.career.totalHeadshots ?? 0).toLocaleString()}</div></div>
        <div class="mm-stat"><div class="mm-stat-label">LONGEST SHOT</div><div class="mm-stat-val">${Math.round(p.career.longestKillDistance ?? 0)}m</div></div>
        <div class="mm-stat"><div class="mm-stat-label">FINISHERS</div><div class="mm-stat-val">${p.career.finishers ?? 0}</div></div>
        <div class="mm-stat"><div class="mm-stat-label">HOURS</div><div class="mm-stat-val">${hoursPlayed}</div></div>
        <div class="mm-stat"><div class="mm-stat-label">WINS</div><div class="mm-stat-val">${p.career.totalWins ?? 0}</div></div>
        <div class="mm-stat"><div class="mm-stat-label">LOGIN STREAK</div><div class="mm-stat-val">${p.loginStreak ?? 0}d</div></div>
      </div>

      <div class="mm-section-head">WEAPON MASTERY</div>
      <div class="mm-weapons">
        ${Object.entries(p.byWeapon ?? {}).slice(0, 8).map(([wpn, ws]: [string, any]) => `
          <div class="mm-weapon-row">
            <div class="mm-weapon-name">${wpn.replace(/_/g, ' ').toUpperCase()}</div>
            <div class="mm-weapon-lvl">LV ${ws.level ?? 1}</div>
            <div class="mm-weapon-bar"><div class="mm-weapon-fill" style="width:${Math.min(100, (ws.level ?? 1) * 10)}%"></div></div>
            <div class="mm-weapon-kills">${ws.kills ?? 0} k</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  CENTER: LOADOUT TAB
// ─────────────────────────────────────────────────────────────────────

function renderLoadoutTab(): string {
  const loadouts = getLoadouts();
  const editing = loadouts[state.editingLoadoutIndex];
  if (!editing) return '<div class="mm-empty">No loadouts</div>';

  const perkRow = (slot: 'perk1' | 'perk2' | 'perk3', perkGroup: number) => {
    const selectedId = editing[slot as keyof typeof editing] as string;
    const perkDef = PERKS.find(p => p.id === selectedId);
    return `
      <div class="mm-slot" data-slot="${slot}">
        <div class="mm-slot-label">PERK ${perkGroup + 1}</div>
        <div class="mm-slot-val">${perkDef?.name ?? '—'}</div>
        <div class="mm-slot-desc">${perkDef?.desc ?? ''}</div>
      </div>
    `;
  };

  return `
    <div class="mm-loadouts-list">
      ${loadouts.map((l, i) => `
        <div class="mm-loadout-btn ${i === state.editingLoadoutIndex ? 'active' : ''} ${i === getProfile().activeLoadoutIndex ? 'equipped' : ''}" data-loadout-idx="${i}">
          <div class="mm-loadout-name">${l.name}</div>
          <div class="mm-loadout-weapons">${l.primary} · ${l.secondary}</div>
          ${i === getProfile().activeLoadoutIndex ? '<div class="mm-equipped-badge">EQUIPPED</div>' : ''}
        </div>
      `).join('')}
    </div>

    <div class="mm-loadout-editor">
      <div class="mm-loadout-head">
        <input type="text" class="mm-loadout-name-input" id="loadoutName" value="${editing.name}"/>
        <button class="mm-btn mm-btn-primary" id="equipLoadoutBtn">EQUIP</button>
      </div>

      <div class="mm-section-head">WEAPONS</div>
      <div class="mm-slots-grid">
        <div class="mm-slot" data-slot="primary">
          <div class="mm-slot-label">PRIMARY</div>
          <div class="mm-slot-val">${editing.primary}</div>
        </div>
        <div class="mm-slot" data-slot="secondary">
          <div class="mm-slot-label">SECONDARY</div>
          <div class="mm-slot-val">${editing.secondary}</div>
        </div>
      </div>

      <div class="mm-section-head">TACTICAL</div>
      <div class="mm-slots-grid">
        <div class="mm-slot" data-slot="lethal">
          <div class="mm-slot-label">LETHAL</div>
          <div class="mm-slot-val">${LETHALS.find(l => l.id === editing.lethal)?.name ?? '—'}</div>
        </div>
        <div class="mm-slot" data-slot="tactical">
          <div class="mm-slot-label">TACTICAL</div>
          <div class="mm-slot-val">${TACTICALS.find(t => t.id === editing.tactical)?.name ?? '—'}</div>
        </div>
        <div class="mm-slot" data-slot="field">
          <div class="mm-slot-label">FIELD UPGRADE</div>
          <div class="mm-slot-val">${FIELD_UPGRADES.find(f => f.id === editing.fieldUpgrade)?.name ?? '—'}</div>
        </div>
      </div>

      <div class="mm-section-head">PERKS</div>
      <div class="mm-slots-grid">
        ${perkRow('perk1', 0)}
        ${perkRow('perk2', 1)}
        ${perkRow('perk3', 2)}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  CENTER: CONTRACTS TAB
// ─────────────────────────────────────────────────────────────────────

function renderContractsTab(): string {
  const dailies = getContracts('daily');
  const weeklies = getContracts('weekly');
  const cc = getActiveContractCount();

  const contractRow = (c: any) => {
    const pct = (c.progress.progress / c.progress.target) * 100;
    return `
      <div class="mm-contract ${c.claimable ? 'completed' : ''} ${c.progress.claimed ? 'claimed' : ''}">
        <div class="mm-contract-head">
          <div class="mm-contract-title">${c.def.title}</div>
          <div class="mm-contract-reward">+${c.def.xpReward} XP</div>
        </div>
        <div class="mm-contract-desc">${c.def.description}</div>
        <div class="mm-contract-progress">
          <div class="mm-contract-bar"><div class="mm-contract-fill" style="width:${Math.min(100, pct)}%"></div></div>
          <div class="mm-contract-num">${c.progress.progress} / ${c.progress.target}</div>
        </div>
        ${c.claimable && !c.progress.claimed ? '<div class="mm-contract-claim">READY TO CLAIM</div>' : ''}
      </div>
    `;
  };

  return `
    <div class="mm-contract-head-bar">
      <div class="mm-contract-title-main">ACTIVE CONTRACTS (${cc.daily + cc.weekly})</div>
      <button class="mm-btn mm-btn-primary" id="claimAllBtn">CLAIM ALL</button>
    </div>
    <div class="mm-section-head">DAILY · Resets in 24h</div>
    <div class="mm-contracts-grid">${dailies.map(contractRow).join('')}</div>
    <div class="mm-section-head">WEEKLY · Resets Monday</div>
    <div class="mm-contracts-grid">${weeklies.map(contractRow).join('')}</div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  CENTER: COSMETICS TAB
// ─────────────────────────────────────────────────────────────────────

function renderCosmeticsTab(): string {
  const p = getProfile();
  const eq = p.equipped;
  const unlocked = p.unlocks;
  return `
    <div class="mm-cos-grid">
      <div class="mm-cos-section">
        <div class="mm-section-head">OPERATOR</div>
        <div class="mm-cos-row">
          <div class="mm-cos-label">Operator</div>
          <div class="mm-cos-val">${eq.operator}</div>
        </div>
      </div>

      <div class="mm-cos-section">
        <div class="mm-section-head">EMOTES (4 slots)</div>
        <div class="mm-cos-emotes">
          ${eq.activeEmotes.slice(0, 4).map((e: string, i: number) => `
            <div class="mm-cos-slot">
              <div class="mm-cos-slot-num">${i + 1}</div>
              <div class="mm-cos-slot-val">${e}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="mm-cos-section">
        <div class="mm-section-head">SPRAYS (3 slots)</div>
        <div class="mm-cos-emotes">
          ${eq.activeSprays.slice(0, 3).map((s: string, i: number) => `
            <div class="mm-cos-slot">
              <div class="mm-cos-slot-num">${i + 1}</div>
              <div class="mm-cos-slot-val">${s}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="mm-cos-section">
        <div class="mm-section-head">FINISHER</div>
        <div class="mm-cos-val">${eq.activeFinisher ?? 'default'}</div>
      </div>

      <div class="mm-cos-section">
        <div class="mm-section-head">INTRO</div>
        <div class="mm-cos-val">${eq.activeIntro ?? 'default'}</div>
      </div>

      <div class="mm-cos-section mm-cos-unlock">
        <div class="mm-section-head">UNLOCKED</div>
        <div class="mm-cos-unlocks">
          <div>${(unlocked.operators ?? []).length} operators</div>
          <div>${(unlocked.emotes ?? []).length} emotes</div>
          <div>${(unlocked.sprays ?? []).length} sprays</div>
          <div>${Object.values(unlocked.weaponCamos ?? {}).flat().length} weapon skins</div>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  CENTER: SETTINGS TAB
// ─────────────────────────────────────────────────────────────────────

function renderSettingsTab(): string {
  return `
    <div class="mm-settings">
      <div class="mm-setting-group">
        <div class="mm-section-head">AUDIO</div>
        <div class="mm-setting-row"><label>Master Volume</label><input type="range" min="0" max="100" step="5" data-setting="masterVol"/><span data-setting-value="masterVol">100%</span></div>
        <div class="mm-setting-row"><label>Music</label><input type="range" min="0" max="100" step="5" data-setting="musicVol"/><span data-setting-value="musicVol">50%</span></div>
        <div class="mm-setting-row"><label>SFX</label><input type="range" min="0" max="100" step="5" data-setting="sfxVol"/><span data-setting-value="sfxVol">100%</span></div>
        <div class="mm-setting-row"><label>Voice / Announcer</label><input type="range" min="0" max="100" step="5" data-setting="voiceVol"/><span data-setting-value="voiceVol">100%</span></div>
        <div class="mm-setting-row"><label>UI</label><input type="range" min="0" max="100" step="5" data-setting="uiVol"/><span data-setting-value="uiVol">80%</span></div>
        <div class="mm-setting-row"><label>Bot Voice TTS</label><label class="mm-checkbox"><input type="checkbox" data-setting="enableBotVoice"/><span>Enabled</span></label><span data-setting-value="enableBotVoice">ON</span></div>
      </div>

      <div class="mm-setting-group">
        <div class="mm-section-head">VISUALS</div>
        <div class="mm-setting-row"><label>FOV</label><input type="range" min="60" max="110" step="1" data-setting="fov"/><span data-setting-value="fov">78</span></div>
        <div class="mm-setting-row"><label>Crosshair Color</label><input type="color" data-setting="crosshairColor"/><span data-setting-value="crosshairColor">#f0faff</span></div>
        <div class="mm-setting-row"><label>Crosshair Size</label><input type="range" min="0.5" max="2" step="0.1" data-setting="crosshairSize"/><span data-setting-value="crosshairSize">1.0</span></div>
        <div class="mm-setting-row"><label>Crosshair Dot</label><label class="mm-checkbox"><input type="checkbox" data-setting="crosshairDot"/><span>Enabled</span></label><span data-setting-value="crosshairDot">ON</span></div>
        <div class="mm-setting-row"><label>Colorblind Mode</label><select data-setting="colorblindMode"><option value="off">Off</option><option value="deuteranopia">Deuteranopia</option><option value="protanopia">Protanopia</option><option value="tritanopia">Tritanopia</option></select><span data-setting-value="colorblindMode">off</span></div>
      </div>

      <div class="mm-setting-group">
        <div class="mm-section-head">CONTROLS & GAMEPLAY</div>
        <div class="mm-setting-row"><label>Mouse Sensitivity</label><input type="range" min="0.0005" max="0.006" step="0.0001" data-setting="sensitivity"/><span data-setting-value="sensitivity">0.0022</span></div>
        <div class="mm-setting-row"><label>Head Bob</label><input type="range" min="0" max="100" step="5" data-setting="headBobScale"/><span data-setting-value="headBobScale">100%</span></div>
        <div class="mm-setting-row"><label>Bot Difficulty</label><input type="range" min="0" max="100" step="10" data-setting="botDifficulty"/><span data-setting-value="botDifficulty">50%</span></div>
        <div class="mm-setting-row"><label>Show FPS</label><label class="mm-checkbox"><input type="checkbox" data-setting="showFPS"/><span>Enabled</span></label><span data-setting-value="showFPS">OFF</span></div>
        <div class="mm-setting-row"><label>Subtitles</label><label class="mm-checkbox"><input type="checkbox" data-setting="showSubtitles"/><span>Enabled</span></label><span data-setting-value="showSubtitles">ON</span></div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  BUILD — DOM only, no style injection (styles are in index.css)
// ─────────────────────────────────────────────────────────────────────

function build(): HTMLDivElement {
  const root = document.createElement('div');
  root.id = 'mainMenuRoot';
  root.innerHTML = `
    <div class="arena-bg"></div>
    <div class="arena-horizon"></div>

    <div class="mn-root">

      <!-- TOP NAV BAR -->
      <div class="mn-top">
        <div class="mn-brand">
          <div class="mn-mark">
            <svg viewBox="0 0 32 32">
              <polygon points="16,2 30,10 30,22 16,30 2,22 2,10" fill="none" stroke="#ff8c1a" stroke-width="2"/>
              <polygon points="16,8 24,13 24,19 16,24 8,19 8,13" fill="#ff8c1a"/>
            </svg>
          </div>
          <div>
            <div class="mn-brand-text">WARZONE</div>
            <div class="mn-brand-sub">APEX PROTOCOL · S04</div>
          </div>
        </div>

        <nav class="mn-nav">
          ${(['play', 'loadout', 'career', 'contracts', 'cosmetics', 'settings'] as Tab[])
            .map(t => `<button class="mn-tab ${state.activeTab === t ? 'on' : ''}" data-tab="${t}">${t.toUpperCase()}</button>`)
            .join('')}
        </nav>

        <div class="mn-user">
          <div class="mn-u-avatar" id="mmAvatar"></div>
          <div class="mn-u-meta">
            <div class="mn-u-name" id="mmUserName"></div>
            <div class="mn-u-level"><b id="mmUserLvl"></b> <span id="mmUserXp"></span></div>
          </div>
        </div>
      </div>

      <!-- THREE-COLUMN MAIN -->
      <div class="mn-main">
        <div class="mn-col" id="mmLeftCol"></div>
        <div class="mn-col mn-center" id="mmContent"></div>
        <div class="mn-col" id="mmRightCol"></div>
      </div>

    </div>
  `;
  document.body.appendChild(root);
  return root;
}

// ─────────────────────────────────────────────────────────────────────
//  REFRESH — re-render content when state changes
// ─────────────────────────────────────────────────────────────────────

function refresh(): void {
  if (!state.container) return;

  state.container.querySelectorAll('.mn-tab').forEach((btn) => {
    btn.classList.toggle('on', (btn as HTMLElement).dataset.tab === state.activeTab);
  });

  const leftCol  = state.container.querySelector('#mmLeftCol');
  const rightCol = state.container.querySelector('#mmRightCol');
  const content  = state.container.querySelector('#mmContent');

  if (leftCol)  leftCol.innerHTML  = renderLeftCol();
  if (rightCol) rightCol.innerHTML = renderRightCol();

  if (content) {
    content.className = state.activeTab === 'play' ? 'mn-col mn-center' : 'mn-col mm-panel';
    switch (state.activeTab) {
      case 'play':      content.innerHTML = renderPlayTab();      break;
      case 'career':    content.innerHTML = renderCareerTab();    break;
      case 'loadout':   content.innerHTML = renderLoadoutTab();   break;
      case 'contracts': content.innerHTML = renderContractsTab(); break;
      case 'cosmetics': content.innerHTML = renderCosmeticsTab(); break;
      case 'settings':  content.innerHTML = renderSettingsTab();  break;
    }

    if (state.activeTab === 'settings') {
      bindSettingsPanel(content);
    }
  }

  // Top-right user strip
  const p = getProfile();
  const xp = getXpProgress();
  const lvl    = state.container.querySelector('#mmUserLvl');
  const name   = state.container.querySelector('#mmUserName');
  const avatar = state.container.querySelector('#mmAvatar');
  const xpEl   = state.container.querySelector('#mmUserXp');
  if (lvl)    lvl.textContent    = `LVL ${p.level}`;
  if (name)   name.textContent   = p.playerName;
  if (avatar) avatar.textContent = p.playerName.substring(0, 2).toUpperCase();
  if (xpEl)   xpEl.textContent   = `· ${xp.current.toLocaleString()} / ${xp.needed.toLocaleString()} XP`;

  wireTabEvents();
}

// ─────────────────────────────────────────────────────────────────────
//  EVENT WIRING
// ─────────────────────────────────────────────────────────────────────

function wireTabEvents(): void {
  if (!state.container) return;

  // Top-nav tab switching
  state.container.querySelectorAll('.mn-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = (btn as HTMLElement).dataset.tab as Tab;
      state.container!.querySelectorAll('.mn-tab').forEach(t => t.classList.remove('on'));
      btn.classList.add('on');
      refresh();
    });
  });

  // Mode cards (PLAY tab)
  state.container.querySelectorAll('.mn-mode').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedMode = (card as HTMLElement).dataset.mode as GameMode;
      state.container!.querySelectorAll('.mn-mode').forEach(c => c.classList.remove('on'));
      card.classList.add('on');
      // Update deploy label without a full refresh
      const def = MODES.find(m => m.id === state.selectedMode);
      const title = state.container!.querySelector('.mn-hero-title');
      const sub   = state.container!.querySelector('.mn-hero-sub');
      const label = state.container!.querySelector('#mmDeploy .mn-deploy-label');
      if (title && def) title.textContent = def.name;
      if (sub && def)   sub.textContent   = def.subtitle;
      if (label) label.textContent = state.selectedMode === 'training' ? 'ENTER TRAINING RANGE' : 'INITIATE MATCH';
    });
  });

  // Deploy button
  const deployBtn = state.container.querySelector('#mmDeploy');
  if (deployBtn) {
    deployBtn.addEventListener('click', () => {
      gameState.renderer?.domElement?.requestPointerLock();
      if (state.selectedMode === 'training') {
        state.onTraining?.();
      } else {
        state.onStart?.(state.selectedMode, state.editingLoadoutIndex);
      }
      hideMainMenu();
    });
  }

  // CAREER: Prestige
  const prestigeBtn = state.container.querySelector('#prestigeBtn');
  if (prestigeBtn) prestigeBtn.addEventListener('click', () => { prestige(); refresh(); });

  // CONTRACTS: Claim all (center tab)
  const claimBtn = state.container.querySelector('#claimAllBtn');
  if (claimBtn) claimBtn.addEventListener('click', () => { claimAllCompleted(); refresh(); });

  // INTEL sidebar: Claim all (right column)
  const claimBtnRight = state.container.querySelector('#claimAllBtnRight');
  if (claimBtnRight) claimBtnRight.addEventListener('click', () => { claimAllCompleted(); refresh(); });

  // LOADOUT: select which loadout to edit
  state.container.querySelectorAll('.mm-loadout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.editingLoadoutIndex = parseInt((btn as HTMLElement).dataset.loadoutIdx ?? '0');
      refresh();
    });
  });

  // LOADOUT: Equip
  const equipBtn = state.container.querySelector('#equipLoadoutBtn');
  if (equipBtn) equipBtn.addEventListener('click', () => { setActiveLoadout(state.editingLoadoutIndex); refresh(); });

  // LOADOUT: Rename
  const nameInput = state.container.querySelector('#loadoutName') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim().substring(0, 20);
      if (name) updateLoadout(state.editingLoadoutIndex, { name });
    });
  }

}

// ─────────────────────────────────────────────────────────────────────
//  PUBLIC API (unchanged signatures — callers in main.ts / Menus.ts work as-is)
// ─────────────────────────────────────────────────────────────────────

export function initMainMenu(
  onStart: (mode: GameMode, loadoutIndex: number) => void,
  onTraining?: () => void,
): void {
  state.onStart = onStart;
  state.onTraining = onTraining ?? null;
  state.container = build();

  // Re-render whenever profile changes (XP tick, contract claim, unlocks, etc.)
  state.unsubscribe = subscribeProfile(() => {
    if (state.visible) refresh();
  });
}

export function showMainMenu(): void {
  if (!state.container) return;
  state.visible = true;
  state.activeTab = 'play';
  state.container.classList.add('active');
  document.body.classList.remove('in-match');
  refresh();
  document.exitPointerLock?.();
}

export function hideMainMenu(): void {
  if (!state.container) return;
  state.visible = false;
  state.container.classList.remove('active');
}
