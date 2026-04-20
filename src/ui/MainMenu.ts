import {
  getProfile, subscribeProfile, getXpProgress, getOverallKD, getWinRate,
  MAX_LEVEL, prestige,
} from '@/core/PlayerProfile';
import { getLoadouts, setActiveLoadout, updateLoadout,
  PERKS, FIELD_UPGRADES, LETHALS, TACTICALS } from '@/config/Loadouts';
import { getContracts, claimAllCompleted, getActiveContractCount } from './ContractSystem';
import type { GameMode } from '@/core/GameModes';

// ─────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────

interface MenuState {
  visible: boolean;
  activeTab: 'play' | 'career' | 'loadout' | 'contracts' | 'cosmetics' | 'settings';
  selectedMode: GameMode;
  editingLoadoutIndex: number;
  loadoutEditSlot: 'primary' | 'secondary' | 'lethal' | 'tactical' | 'perk1' | 'perk2' | 'perk3' | 'field' | null;
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
  loadoutEditSlot: null,
  onStart: null,
  onTraining: null,
  container: null,
  unsubscribe: null,
};

// ─────────────────────────────────────────────────────────────────────
//  MODE DEFINITIONS  (6 primary modes shown in 3×2 grid)
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
];

// ─────────────────────────────────────────────────────────────────────
//  LEFT COLUMN — operator card + career stats + XP rail
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
//  RIGHT COLUMN — intel: contracts preview + news
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
//  CENTER: PLAY TAB — hero slate + 3×2 modes + loadout strip + deploy
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
        <span class="mn-loadout-cycle">TAB LOADOUT TO EDIT</span>
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
            <span class="mm-level-pill">${prestigeLevel > 0 ? `P${prestigeLevel}` : ''} LVL ${p.level}</span>
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
            <div class="mm-weapon-kills">${(ws.kills ?? 0)} k</div>
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
        <div class="mm-setting-row"><label>Master Volume</label><input type="range" min="0" max="100" value="80" id="sMaster"/><span id="sMasterVal">80%</span></div>
        <div class="mm-setting-row"><label>Music</label><input type="range" min="0" max="100" value="60" id="sMusic"/><span id="sMusicVal">60%</span></div>
        <div class="mm-setting-row"><label>SFX</label><input type="range" min="0" max="100" value="90" id="sSfx"/><span id="sSfxVal">90%</span></div>
        <div class="mm-setting-row"><label>Voice Callouts</label><input type="range" min="0" max="100" value="75" id="sVoice"/><span id="sVoiceVal">75%</span></div>
      </div>

      <div class="mm-setting-group">
        <div class="mm-section-head">GRAPHICS</div>
        <div class="mm-setting-row"><label>FOV</label><input type="range" min="60" max="110" value="75" id="sFov"/><span id="sFovVal">75</span></div>
        <div class="mm-setting-row"><label>Shadows</label><select id="sShadows"><option>Low</option><option selected>Medium</option><option>High</option></select></div>
        <div class="mm-setting-row"><label>Particles</label><select id="sParticles"><option>Low</option><option selected>Medium</option><option>High</option></select></div>
      </div>

      <div class="mm-setting-group">
        <div class="mm-section-head">CONTROLS</div>
        <div class="mm-setting-row"><label>Mouse Sensitivity</label><input type="range" min="1" max="20" value="8" id="sSens"/><span id="sSensVal">8</span></div>
        <div class="mm-setting-row"><label>ADS Sensitivity Mult</label><input type="range" min="5" max="15" value="10" id="sAds"/><span id="sAdsVal">1.0</span></div>
        <div class="mm-setting-row"><label>Invert Y</label><input type="checkbox" id="sInvert"/></div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  BUILD — three-column APEX PROTOCOL shell
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
            <div class="mn-brand-sub">TDM · SEASON 04</div>
          </div>
        </div>

        <nav class="mn-nav">
          ${['play', 'career', 'loadout', 'contracts', 'cosmetics', 'settings'].map(t =>
            `<button class="mn-tab ${state.activeTab === t ? 'on' : ''}" data-tab="${t}">${t.toUpperCase()}</button>`
          ).join('')}
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

      <!-- BOTTOM STRIP -->
      <div class="mn-bottom">
        <div class="mn-server">
          <div class="dot"></div>
          <span>SERVER <b>EU-WEST-01</b></span>
          <span>PING <b>&lt;30ms</b></span>
        </div>
        <div class="mn-keys">
          <div class="mn-key"><kbd>ESC</kbd> <span>PAUSE</span></div>
          <div class="mn-key"><kbd>TAB</kbd> <span>SCOREBOARD</span></div>
        </div>
        <button class="mn-quit-btn" id="mmQuit">QUIT</button>
      </div>

    </div>
  `;
  document.body.appendChild(root);
  injectStyles();
  return root;
}

// ─────────────────────────────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('mainMenuStyle')) return;
  const s = document.createElement('style');
  s.id = 'mainMenuStyle';
  s.textContent = `

    /* ── ROOT CONTAINER ─────────────────────────────────────── */
    #mainMenuRoot {
      position: fixed; inset: 0; z-index: 20;
      font-family: var(--body-font, 'Chakra Petch', sans-serif);
      color: var(--bone, #e9ecf1);
      display: none;
      overflow: hidden;
    }
    #mainMenuRoot.active { display: block; }

    /* ── ARENA BACKGROUND ───────────────────────────────────── */
    .arena-bg {
      position: absolute; inset: 0; z-index: 0;
      background:
        radial-gradient(ellipse at 70% 30%, rgba(255,140,26,.12) 0%, transparent 50%),
        radial-gradient(ellipse at 20% 80%, rgba(57,240,255,.06) 0%, transparent 55%),
        linear-gradient(180deg, #0a0d15 0%, #06070b 60%, #0a0808 100%);
    }
    .arena-bg::before {
      content: ''; position: absolute; inset: 0;
      background:
        linear-gradient(180deg, transparent 55%, rgba(0,0,0,.5) 100%),
        linear-gradient(90deg, rgba(0,0,0,.6), transparent 20%, transparent 80%, rgba(0,0,0,.6));
    }
    .arena-bg::after {
      content: ''; position: absolute; inset: 0;
      background-image:
        linear-gradient(rgba(255,140,26,.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,140,26,.04) 1px, transparent 1px);
      background-size: 80px 80px;
      mask-image: radial-gradient(ellipse at center, black 30%, transparent 70%);
      animation: gridDrift 90s linear infinite;
    }
    @keyframes gridDrift { to { background-position: 80px 80px; } }

    .arena-horizon {
      position: absolute; left: 0; right: 0; bottom: 0; height: 45%;
      background:
        linear-gradient(180deg, transparent 0%, rgba(6,7,11,.7) 80%, rgba(6,7,11,1) 100%),
        url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 400' preserveAspectRatio='none'><polygon fill='%23090b11' points='0,400 0,280 120,260 180,220 260,240 340,180 430,200 520,160 640,180 730,140 840,190 950,150 1060,210 1180,170 1290,230 1400,190 1520,250 1600,220 1600,400'/><polygon fill='%2306070b' points='0,400 0,330 80,310 170,340 260,290 370,320 480,280 580,310 690,270 820,300 930,260 1050,290 1160,250 1280,310 1400,270 1510,300 1600,280 1600,400'/></svg>") bottom/cover no-repeat;
      z-index: 0; pointer-events: none;
    }

    /* ── MN-ROOT: 3-row grid ────────────────────────────────── */
    .mn-root {
      position: absolute; inset: 0; z-index: 1;
      display: grid;
      grid-template-rows: 64px 1fr 56px;
    }

    /* ── TOP NAV BAR ────────────────────────────────────────── */
    .mn-top {
      display: grid; grid-template-columns: auto 1fr auto;
      align-items: stretch;
      border-bottom: 1px solid var(--hairline, rgba(233,236,241,.08));
      padding-left: 40px;
      z-index: 2;
      background: linear-gradient(180deg, rgba(6,7,11,.96), rgba(6,7,11,.80));
    }

    .mn-brand { display: flex; align-items: center; gap: 14px; }
    .mn-mark {
      width: 28px; height: 28px;
      display: grid; place-items: center;
    }
    .mn-mark svg { width: 100%; height: 100%; }
    .mn-brand-text {
      font: 400 18px/1 var(--tactical-font, 'Syncopate', sans-serif);
      letter-spacing: .4em; color: var(--bone);
    }
    .mn-brand-sub {
      font: 400 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .35em; color: var(--signal, #ff8c1a);
      margin-top: 3px;
    }

    .mn-nav { display: flex; justify-content: center; }
    .mn-tab {
      position: relative; padding: 0 24px; display: grid; place-items: center;
      background: transparent; border: 0; cursor: pointer;
      font: 500 11px/1 var(--tactical-font, 'Syncopate', sans-serif);
      letter-spacing: .3em; color: var(--mute, #6d7689);
      transition: color .15s;
    }
    .mn-tab::before {
      content: ''; position: absolute; bottom: 0; left: 50%; width: 0; height: 2px;
      background: var(--signal); transform: translateX(-50%);
      transition: width .25s var(--ease-out-expo, cubic-bezier(.16,1,.3,1));
    }
    .mn-tab:hover { color: var(--bone); }
    .mn-tab.on { color: var(--signal); }
    .mn-tab.on::before { width: 60%; }

    .mn-user {
      display: flex; align-items: center; gap: 14px;
      padding: 0 32px 0 20px;
      border-left: 1px solid var(--hairline);
    }
    .mn-u-avatar {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, var(--signal), #a85a0f);
      display: grid; place-items: center;
      font: 400 14px/1 var(--tactical-font, 'Syncopate', sans-serif);
      color: var(--void, #06070b);
      clip-path: polygon(0 0, 100% 0, 100% 75%, 75% 100%, 0 100%);
    }
    .mn-u-name {
      font: 500 13px/1 var(--body-font, 'Chakra Petch', sans-serif);
      color: var(--bone); letter-spacing: .1em;
    }
    .mn-u-level {
      display: flex; gap: 6px; align-items: baseline; margin-top: 2px;
      font: 400 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .2em;
    }
    .mn-u-level b { color: var(--signal); font-weight: 500; }
    .mn-u-level span { color: var(--mute); }

    /* ── THREE-COLUMN MAIN ──────────────────────────────────── */
    .mn-main {
      position: relative; z-index: 1;
      display: grid; grid-template-columns: 320px 1fr 360px;
      overflow: hidden;
    }
    .mn-col {
      padding: 24px 28px;
      overflow-y: auto;
      position: relative;
    }
    .mn-col + .mn-col { border-left: 1px solid var(--hairline); }
    .mn-col::-webkit-scrollbar { width: 2px; }
    .mn-col::-webkit-scrollbar-thumb { background: var(--signal); }

    /* Center column: flex column so deploy button can push to bottom */
    .mn-center {
      display: flex; flex-direction: column; gap: 20px;
      padding: 32px 40px;
    }

    /* ── COL HEADER ─────────────────────────────────────────── */
    .mn-col-head {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 18px;
    }
    .mn-col-head::before { content: ''; width: 4px; height: 16px; background: var(--signal); }
    .mn-col-head-text {
      font: 500 11px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .4em; color: var(--bone);
    }
    .mn-col-head-id {
      margin-left: auto;
      font: 400 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--mute); letter-spacing: .2em;
    }

    /* ── OPERATOR CARD (left col) ───────────────────────────── */
    .mn-op-card {
      position: relative;
      padding: 16px;
      background: linear-gradient(145deg, rgba(255,140,26,.05), transparent 60%);
      border: 1px solid var(--hairline);
      margin-bottom: 14px;
    }
    .mn-op-figure {
      aspect-ratio: 3/4;
      background:
        radial-gradient(ellipse at top, rgba(255,140,26,.18), transparent 60%),
        linear-gradient(180deg, #0f1220, #050708 80%);
      position: relative; overflow: hidden;
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%);
      margin-bottom: 12px;
      display: grid; place-items: center;
    }
    .mn-op-silhouette { width: 70%; opacity: .9; }
    .mn-op-figure::after {
      content: ''; position: absolute; inset: 0;
      background: repeating-linear-gradient(0deg, rgba(255,255,255,.015) 0 2px, transparent 2px 4px);
      pointer-events: none;
    }
    .mn-op-rank-chip {
      position: absolute; top: 8px; left: 8px;
      padding: 3px 8px;
      background: var(--signal); color: var(--void);
      font: 500 9px/1 var(--mono-font, 'JetBrains Mono', monospace); letter-spacing: .2em;
    }
    .mn-op-name {
      font: 400 20px/1 var(--display-font, 'Archivo Black', sans-serif);
      letter-spacing: .02em; color: var(--bone);
    }
    .mn-op-callsign {
      font: 400 9px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--signal); letter-spacing: .25em; margin-top: 4px;
    }

    /* corner bracket helper (4-corner version) */
    .br4 { position: relative; }
    .br4 > .br-tr, .br4 > .br-bl {
      position: absolute; width: 14px; height: 14px;
      border: 1px solid var(--signal); pointer-events: none;
    }
    .br4 > .br-tr { top: -1px; right: -1px; border-left: 0; border-bottom: 0; }
    .br4 > .br-bl { bottom: -1px; left: -1px; border-right: 0; border-top: 0; }
    .br4::before, .br4::after {
      content: ''; position: absolute; width: 14px; height: 14px;
      border: 1px solid var(--signal); pointer-events: none;
    }
    .br4::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
    .br4::after  { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }

    /* ── STAT GRID (left col) ───────────────────────────────── */
    .mn-statgrid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
      background: var(--hairline); border: 1px solid var(--hairline);
      margin-bottom: 16px;
    }
    .mn-stat { background: var(--void, #06070b); padding: 10px 12px; }
    .mn-stat-label {
      font: 400 9px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .3em; color: var(--mute); margin-bottom: 4px;
    }
    .mn-stat-val {
      font: 400 20px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--bone); letter-spacing: -.01em;
    }
    .mn-stat-val.acc { color: var(--signal); }

    /* ── PROGRESS RAIL (left col) ───────────────────────────── */
    .mn-prog-head {
      display: flex; justify-content: space-between; align-items: baseline;
      font: 500 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .2em; color: var(--mute); margin-bottom: 6px;
    }
    .mn-prog-head b { color: var(--signal); font-weight: 500; }
    .mn-prog-rail {
      position: relative; height: 4px; background: var(--steel-800, #131823);
      clip-path: polygon(0 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
    }
    .mn-prog-fill {
      position: absolute; inset: 0 auto 0 0;
      background: linear-gradient(90deg, #a85a0f, var(--signal));
      box-shadow: 0 0 8px rgba(255,140,26,.5);
    }
    .mn-prog-sub {
      font: 400 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--mute); letter-spacing: .2em; margin-top: 6px;
    }

    /* ── HERO SLATE (center play tab) ───────────────────────── */
    .mn-hero-slate {
      padding: 18px 24px 22px;
      border-left: 3px solid var(--signal);
      background: linear-gradient(90deg, rgba(255,140,26,.10), transparent 60%);
    }
    .mn-hero-kicker {
      font: 500 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--signal); letter-spacing: .4em; margin-bottom: 10px;
    }
    .mn-hero-title {
      font: 400 44px/.95 var(--display-font, 'Archivo Black', sans-serif);
      color: var(--bone); letter-spacing: -.02em;
    }
    .mn-hero-sub {
      margin-top: 8px;
      font: 400 12px/1.5 var(--body-font, 'Chakra Petch', sans-serif);
      color: var(--bone-dim, #b5bcc8); max-width: 520px;
    }

    /* ── MODE CARDS (center play tab, 3×2) ─────────────────── */
    .mn-modes {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    }
    .mn-mode {
      position: relative;
      padding: 14px 16px 12px;
      background: rgba(10,12,18,.7);
      border: 1px solid var(--hairline);
      cursor: pointer;
      transition: border-color .18s, background .18s, transform .18s var(--ease-out-expo, cubic-bezier(.16,1,.3,1));
      overflow: hidden;
    }
    .mn-mode::before {
      content: ''; position: absolute; top: 0; left: 0; width: 0; height: 2px;
      background: var(--signal);
      transition: width .3s var(--ease-out-expo, cubic-bezier(.16,1,.3,1));
    }
    .mn-mode:hover { border-color: var(--hairline-strong, rgba(233,236,241,.18)); background: rgba(255,140,26,.03); }
    .mn-mode:hover::before { width: 100%; }
    .mn-mode.on {
      background: linear-gradient(135deg, rgba(255,140,26,.15), transparent 60%);
      border-color: var(--signal);
    }
    .mn-mode.on::before { width: 100%; }
    .mn-mode-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .mn-mode-ico { width: 20px; height: 20px; color: var(--signal); flex-shrink: 0; }
    .mn-mode-ico svg { width: 100%; height: 100%; }
    .mn-mode-name {
      font: 500 11px/1 var(--tactical-font, 'Syncopate', sans-serif);
      letter-spacing: .18em; color: var(--bone);
    }
    .mn-mode-sub {
      font: 400 10px/1.4 var(--body-font, 'Chakra Petch', sans-serif);
      color: var(--bone-dim, #b5bcc8);
    }
    .mn-mode-tag {
      margin-top: 8px; display: inline-block;
      font: 400 9px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--mute); letter-spacing: .2em;
    }
    .mn-mode-tag::before { content: '['; color: var(--signal); margin-right: 2px; }
    .mn-mode-tag::after  { content: ']'; color: var(--signal); margin-left: 2px; }

    /* ── LOADOUT STRIP (center play tab) ────────────────────── */
    .mn-loadout {
      padding: 14px 18px;
      background: rgba(10,12,18,.55);
      border: 1px solid var(--hairline);
    }
    .mn-loadout-head {
      display: flex; align-items: center; gap: 14px;
      margin-bottom: 12px;
    }
    .mn-loadout-title {
      font: 500 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .3em; color: var(--mute);
    }
    .mn-loadout-active {
      padding: 3px 10px;
      background: var(--signal); color: var(--void);
      font: 500 10px/1 var(--tactical-font, 'Syncopate', sans-serif);
      letter-spacing: .15em;
    }
    .mn-loadout-cycle {
      margin-left: auto;
      font: 400 9px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--mute); letter-spacing: .15em;
    }
    .mn-loadout-slots {
      display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr; gap: 6px;
    }
    .mn-slot {
      padding: 8px 10px;
      background: rgba(6,7,11,.7);
      border: 1px solid var(--hairline);
    }
    .mn-slot-label {
      font: 400 8px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--mute); letter-spacing: .25em; margin-bottom: 4px;
    }
    .mn-slot-value {
      font: 500 10px/1 var(--body-font, 'Chakra Petch', sans-serif);
      color: var(--bone); letter-spacing: .04em;
    }
    .mn-slot.primary .mn-slot-value {
      font-family: var(--tactical-font, 'Syncopate', sans-serif);
      font-size: 11px; letter-spacing: .1em;
    }

    /* ── DEPLOY BUTTON ──────────────────────────────────────── */
    .mn-deploy {
      display: grid; grid-template-columns: 1fr auto; align-items: center;
      padding: 18px 24px;
      background: linear-gradient(90deg, var(--signal) 0%, #ffa73a 100%);
      color: var(--void);
      border: 0; cursor: pointer;
      position: relative;
      clip-path: polygon(0 0, calc(100% - 24px) 0, 100% 100%, 0 100%);
      transition: filter .2s, transform .2s var(--ease-out-expo, cubic-bezier(.16,1,.3,1));
      margin-top: auto;
    }
    .mn-deploy:hover { filter: brightness(1.1); transform: translateX(4px); }
    .mn-deploy::before {
      content: ''; position: absolute; inset: 0;
      background: repeating-linear-gradient(135deg, rgba(0,0,0,.08) 0 8px, transparent 8px 16px);
      pointer-events: none;
    }
    .mn-deploy-kicker {
      font: 500 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .3em; color: rgba(6,7,11,.75); margin-bottom: 6px;
    }
    .mn-deploy-label {
      font: 400 26px/1 var(--display-font, 'Archivo Black', sans-serif);
      letter-spacing: .02em;
    }
    .mn-deploy-arrow { font-size: 36px; font-weight: 900; padding-right: 16px; }

    /* ── RIGHT COL: contracts ───────────────────────────────── */
    .mn-news {
      padding: 12px 14px;
      border-left: 2px solid var(--cyan, #39f0ff);
      background: linear-gradient(90deg, rgba(57,240,255,.06), transparent 70%);
      margin-bottom: 14px;
    }
    .mn-news-tag {
      font: 500 9px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--cyan, #39f0ff); letter-spacing: .3em; margin-bottom: 4px;
    }
    .mn-news-title {
      font: 500 12px/1.3 var(--tactical-font, 'Syncopate', sans-serif);
      letter-spacing: .08em; color: var(--bone); margin-bottom: 4px;
    }
    .mn-news-desc {
      font: 400 11px/1.4 var(--body-font, 'Chakra Petch', sans-serif);
      color: var(--bone-dim, #b5bcc8);
    }

    .mn-contract {
      padding: 12px 14px;
      border: 1px solid var(--hairline);
      background: rgba(10,12,18,.7);
      margin-bottom: 8px;
      position: relative;
      transition: border-color .2s, background .2s;
    }
    .mn-contract:hover { border-color: var(--signal); background: rgba(255,140,26,.04); }
    .mn-contract.done { border-color: var(--toxic, #b8ff3d); background: rgba(184,255,61,.06); }
    .mn-contract-head {
      display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px;
    }
    .mn-contract-name {
      font: 500 11px/1 var(--tactical-font, 'Syncopate', sans-serif);
      letter-spacing: .12em; color: var(--bone); flex: 1;
    }
    .mn-contract-xp {
      font: 500 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--signal); letter-spacing: .1em;
    }
    .mn-contract-desc {
      font: 400 10px/1.4 var(--body-font, 'Chakra Petch', sans-serif);
      color: var(--bone-dim, #b5bcc8); margin-bottom: 8px;
    }
    .mn-contract-rail { position: relative; height: 2px; background: var(--steel-800, #131823); }
    .mn-contract-rail-fill {
      position: absolute; inset: 0 auto 0 0;
      background: var(--signal); box-shadow: 0 0 6px rgba(255,140,26,.5);
    }
    .mn-contract.done .mn-contract-rail-fill {
      background: var(--toxic, #b8ff3d); box-shadow: 0 0 6px rgba(184,255,61,.5);
    }
    .mn-contract-meta {
      display: flex; justify-content: space-between; align-items: baseline;
      margin-top: 6px;
      font: 400 9px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--mute); letter-spacing: .15em;
    }

    .mn-empty-intel {
      font: 500 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      color: var(--mute); letter-spacing: .35em; text-align: center;
      padding: 24px 0;
    }
    .mn-claim-btn {
      width: 100%; padding: 12px;
      background: rgba(184,255,61,.12); border: 1px solid var(--toxic, #b8ff3d);
      color: var(--toxic, #b8ff3d);
      font: 500 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .3em; cursor: pointer;
      transition: background .15s;
    }
    .mn-claim-btn:hover { background: rgba(184,255,61,.22); }

    /* ── BOTTOM STRIP ───────────────────────────────────────── */
    .mn-bottom {
      display: grid; grid-template-columns: auto 1fr auto;
      align-items: center; gap: 24px;
      padding: 0 32px;
      border-top: 1px solid var(--hairline);
      background: rgba(6,7,11,.95);
      z-index: 2;
    }
    .mn-server {
      display: flex; align-items: center; gap: 10px;
      font: 400 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .2em; color: var(--mute);
    }
    .mn-server .dot {
      width: 6px; height: 6px; background: var(--toxic, #b8ff3d);
      box-shadow: 0 0 6px var(--toxic, #b8ff3d);
      border-radius: 50%;
      animation: pulse 1.8s ease-in-out infinite;
    }
    @keyframes pulse { 50% { transform: scale(1.4); opacity: .5; } }
    .mn-server b { color: var(--bone); font-weight: 500; }
    .mn-keys { display: flex; gap: 10px; justify-content: center; }
    .mn-key {
      display: flex; align-items: center; gap: 6px;
      font: 400 10px/1 var(--mono-font, 'JetBrains Mono', monospace);
      letter-spacing: .15em; color: var(--mute);
    }
    .mn-key kbd {
      display: inline-block; min-width: 16px; padding: 3px 6px;
      background: var(--steel-800, #131823);
      border: 1px solid var(--hairline);
      color: var(--bone); font: inherit;
    }
    .mn-quit-btn {
      background: transparent; border: 1px solid var(--hairline);
      color: var(--mute);
      font: 500 10px/1 var(--tactical-font, 'Syncopate', sans-serif);
      letter-spacing: .25em; padding: 10px 20px; cursor: pointer;
      transition: color .15s, border-color .15s;
    }
    .mn-quit-btn:hover { color: var(--hazard, #ff3d2e); border-color: var(--hazard, #ff3d2e); }

    /* ══════════════════════════════════════════════════════════
       TAB-CONTENT: Career, Loadout, Contracts, Cosmetics, Settings
       (mm-* prefix; these render inside .mn-center)
       ══════════════════════════════════════════════════════════ */

    .mm-career { flex: 1; }
    .mm-career-head { display: flex; gap: 20px; align-items: center; margin-bottom: 24px; }
    .mm-avatar {
      width: 72px; height: 72px;
      background: var(--steel-800, #131823);
      border: 1px solid var(--signal);
      display: grid; place-items: center;
      font-family: var(--display-font, 'Archivo Black', sans-serif);
      font-size: 28px; font-weight: 400;
      color: var(--signal); position: relative;
      flex-shrink: 0;
    }
    .mm-avatar::before, .mm-avatar::after {
      content: ''; position: absolute;
      width: 8px; height: 8px; border: 1px solid var(--signal);
    }
    .mm-avatar::before { top: -2px; left: -2px; border-right: 0; border-bottom: 0; }
    .mm-avatar::after  { bottom: -2px; right: -2px; border-left: 0; border-top: 0; }
    .mm-career-name { flex: 1; }
    .mm-career-username { font-family: var(--display-font, 'Archivo Black', sans-serif); font-size: 26px; font-weight: 400; letter-spacing: -.01em; color: var(--bone); }
    .mm-career-level { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
    .mm-level-pill { background: rgba(255,140,26,.15); color: var(--signal); padding: 4px 12px; font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 11px; font-weight: 700; letter-spacing: .2em; }
    .mm-level-sub { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 11px; color: var(--mute); letter-spacing: .12em; }
    .mm-xp-bar { height: 4px; width: 100%; max-width: 440px; background: var(--steel-700, #1c2333); }
    .mm-xp-fill { height: 100%; background: linear-gradient(90deg, #a85a0f, var(--signal), #ffa73a); transition: width .4s ease-out; box-shadow: 0 0 8px rgba(255,140,26,.5); }

    .mm-prestige-section {
      background: linear-gradient(135deg, rgba(194,123,255,.1), transparent 70%);
      border: 1px solid rgba(194,123,255,.3); border-left: 3px solid #c27bff;
      padding: 14px 18px; margin-bottom: 20px;
    }
    .mm-prestige-title { font-family: var(--tactical-font, 'Syncopate', sans-serif); color: #c27bff; font-size: 12px; letter-spacing: .3em; margin-bottom: 6px; }
    .mm-prestige-desc { font-family: var(--body-font, 'Chakra Petch', sans-serif); font-size: 12px; color: var(--bone-dim, #b5bcc8); margin-bottom: 10px; }

    .mm-stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 20px; }
    .mm-stat { background: var(--steel-900, #0d1018); border: 1px solid var(--hairline); border-left: 3px solid var(--signal); padding: 10px 12px; }
    .mm-stat-label { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 9px; letter-spacing: .25em; color: var(--mute); }
    .mm-stat-val { font-family: var(--display-font, 'Archivo Black', sans-serif); font-size: 20px; font-weight: 400; color: var(--bone); margin-top: 4px; }

    .mm-section-head {
      font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 10px; letter-spacing: .35em;
      color: var(--signal); font-weight: 700;
      margin: 18px 0 10px; padding-bottom: 8px;
      border-bottom: 1px solid var(--hairline);
      display: flex; align-items: center; gap: 8px;
    }
    .mm-section-head::before { content: ''; width: 3px; height: 12px; background: var(--signal); }

    .mm-weapons { display: flex; flex-direction: column; gap: 3px; }
    .mm-weapon-row { display: grid; grid-template-columns: 150px 48px 1fr 56px; gap: 10px; align-items: center; background: var(--steel-900, #0d1018); padding: 7px 12px; }
    .mm-weapon-name { font-family: var(--tactical-font, 'Syncopate', sans-serif); font-size: 10px; letter-spacing: .12em; color: var(--bone); }
    .mm-weapon-lvl { font-family: var(--mono-font, 'JetBrains Mono', monospace); color: var(--signal); font-size: 11px; font-weight: 700; }
    .mm-weapon-bar { height: 3px; background: var(--steel-700, #1c2333); }
    .mm-weapon-fill { height: 100%; background: linear-gradient(90deg, #a85a0f, var(--signal)); }
    .mm-weapon-kills { font-family: var(--mono-font, 'JetBrains Mono', monospace); text-align: right; color: var(--mute); font-size: 11px; }

    /* Loadout tab */
    .mm-loadouts-list { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
    .mm-loadout-btn {
      background: var(--steel-900, #0d1018); border: 1px solid var(--hairline);
      padding: 10px 16px; cursor: pointer;
      font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 11px;
      letter-spacing: .2em; color: var(--mute); transition: all .15s;
    }
    .mm-loadout-btn:hover { border-color: var(--signal); color: var(--signal); }
    .mm-loadout-btn.active { border-color: var(--signal); color: var(--signal); background: rgba(255,140,26,.1); }
    .mm-loadout-btn.equipped { border-color: var(--toxic, #b8ff3d); color: var(--toxic, #b8ff3d); background: rgba(184,255,61,.07); }
    .mm-loadout-editor { background: var(--steel-900, #0d1018); border: 1px solid var(--hairline); padding: 20px; }
    .mm-loadout-head { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
    .mm-loadout-name-input {
      background: transparent; color: var(--bone); border: none;
      border-bottom: 1px solid var(--hairline);
      font-family: var(--tactical-font, 'Syncopate', sans-serif);
      font-size: 16px; letter-spacing: .1em;
      width: 100%; padding: 6px 0;
    }
    .mm-loadout-name-input:focus { outline: none; border-bottom-color: var(--signal); }
    .mm-slots-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
    .mm-slot { background: var(--steel-800, #131823); border: 1px solid var(--hairline); padding: 10px 12px; }
    .mm-slot-label { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 9px; letter-spacing: .3em; color: var(--mute); margin-bottom: 4px; }
    .mm-slot-val { font-family: var(--body-font, 'Chakra Petch', sans-serif); font-size: 12px; color: var(--bone); font-weight: 600; }
    .mm-slot-desc { font-family: var(--body-font, 'Chakra Petch', sans-serif); font-size: 10px; color: var(--mute); margin-top: 3px; }
    .mm-loadout-name { font-family: var(--tactical-font, 'Syncopate', sans-serif); font-size: 10px; letter-spacing: .2em; color: var(--bone); }
    .mm-loadout-weapons { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 9px; color: var(--mute); letter-spacing: .1em; margin-top: 3px; }
    .mm-equipped-badge { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 9px; color: var(--toxic, #b8ff3d); letter-spacing: .2em; margin-top: 3px; }

    /* Contracts tab */
    .mm-contract-head-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .mm-contract-title-main { font-family: var(--tactical-font, 'Syncopate', sans-serif); font-size: 11px; letter-spacing: .25em; color: var(--bone); }
    .mm-contracts-grid { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
    .mm-contract { background: var(--steel-900, #0d1018); border: 1px solid var(--hairline); padding: 12px 16px; position: relative; }
    .mm-contract.completed { border-left: 3px solid var(--toxic, #b8ff3d); }
    .mm-contract.claimed { opacity: .45; }
    .mm-contract-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
    .mm-contract-title { font-family: var(--body-font, 'Chakra Petch', sans-serif); font-size: 12px; font-weight: 600; color: var(--bone); letter-spacing: .08em; }
    .mm-contract-reward { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 11px; font-weight: 700; color: var(--signal); letter-spacing: .15em; }
    .mm-contract-desc { font-family: var(--body-font, 'Chakra Petch', sans-serif); font-size: 11px; color: var(--mute); margin-bottom: 8px; }
    .mm-contract-progress { display: flex; align-items: center; gap: 10px; }
    .mm-contract-bar { flex: 1; height: 3px; background: var(--steel-700, #1c2333); overflow: hidden; }
    .mm-contract-fill { height: 100%; background: var(--signal); box-shadow: 0 0 4px rgba(255,140,26,.5); transition: width .3s ease; }
    .mm-contract-num { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 10px; color: var(--mute); letter-spacing: .1em; }
    .mm-contract-claim { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 9px; color: var(--toxic, #b8ff3d); letter-spacing: .25em; margin-top: 6px; }

    /* Cosmetics tab */
    .mm-cos-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .mm-cos-section { background: var(--steel-900, #0d1018); border: 1px solid var(--hairline); padding: 14px 16px; }
    .mm-cos-row { display: flex; justify-content: space-between; padding: 4px 0; font-family: var(--body-font, 'Chakra Petch', sans-serif); font-size: 12px; }
    .mm-cos-label { color: var(--mute); }
    .mm-cos-val { font-weight: 700; color: var(--bone); }
    .mm-cos-emotes { display: flex; gap: 6px; }
    .mm-cos-slot { background: var(--steel-800, #131823); padding: 8px 10px; text-align: center; border: 1px solid var(--hairline); flex: 1; }
    .mm-cos-slot-num { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 9px; color: var(--mute); margin-bottom: 4px; letter-spacing: .2em; }
    .mm-cos-slot-val { font-family: var(--body-font, 'Chakra Petch', sans-serif); font-size: 10px; font-weight: 700; color: var(--bone); }
    .mm-cos-unlocks { display: flex; gap: 14px; font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 11px; color: var(--mute); letter-spacing: .1em; }
    .mm-cos-unlock { grid-column: span 2; }

    /* Settings tab */
    .mm-settings { max-width: 600px; flex: 1; }
    .mm-setting-group { margin-bottom: 20px; }
    .mm-setting-row { display: grid; grid-template-columns: 200px 1fr 52px; align-items: center; gap: 14px; padding: 7px 0; }
    .mm-setting-row label { font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 10px; letter-spacing: .25em; color: var(--mute); }
    .mm-setting-row input[type="range"] { accent-color: var(--signal); }
    .mm-setting-row select { background: var(--steel-800, #131823); color: var(--bone); border: 1px solid var(--hairline); padding: 6px 10px; font-family: var(--mono-font, 'JetBrains Mono', monospace); font-size: 11px; }
    .mm-setting-row input[type="checkbox"] { accent-color: var(--signal); width: 18px; height: 18px; }
    .mm-setting-row span { font-family: var(--mono-font, 'JetBrains Mono', monospace); min-width: 40px; text-align: right; font-size: 11px; color: var(--signal); letter-spacing: .1em; }

    /* Shared button */
    .mm-btn {
      background: var(--steel-800, #131823); color: var(--bone);
      border: 1px solid var(--hairline-strong, rgba(233,236,241,.18));
      padding: 10px 20px;
      font-family: var(--tactical-font, 'Syncopate', sans-serif);
      font-size: 11px; letter-spacing: .25em;
      cursor: pointer; transition: all .15s var(--ease-out-expo, cubic-bezier(.16,1,.3,1));
      white-space: nowrap;
    }
    .mm-btn:hover { border-color: var(--signal); color: var(--signal); }
    .mm-btn-primary {
      background: var(--signal); color: var(--void);
      border-color: var(--signal);
      clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 100%, 0 100%);
    }
    .mm-btn-primary:hover { filter: brightness(1.12); color: var(--void); transform: translateX(4px); }
    .mm-btn-secondary { background: transparent; border-color: var(--hairline); }
    .mm-empty {
      text-align: center; color: var(--mute);
      font-family: var(--mono-font, 'JetBrains Mono', monospace);
      padding: 60px 0; font-size: 12px; letter-spacing: .25em;
    }
  `;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────
//  REFRESH
// ─────────────────────────────────────────────────────────────────────

function refresh(): void {
  if (!state.container) return;

  const leftCol = state.container.querySelector('#mmLeftCol');
  const rightCol = state.container.querySelector('#mmRightCol');
  const content = state.container.querySelector('#mmContent');

  if (leftCol) leftCol.innerHTML = renderLeftCol();
  if (rightCol) rightCol.innerHTML = renderRightCol();

  if (content) {
    switch (state.activeTab) {
      case 'play':      content.innerHTML = renderPlayTab(); break;
      case 'career':    content.innerHTML = renderCareerTab(); break;
      case 'loadout':   content.innerHTML = renderLoadoutTab(); break;
      case 'contracts': content.innerHTML = renderContractsTab(); break;
      case 'cosmetics': content.innerHTML = renderCosmeticsTab(); break;
      case 'settings':  content.innerHTML = renderSettingsTab(); break;
    }
  }

  const p = getProfile();
  const xp = getXpProgress();
  const lvl = state.container.querySelector('#mmUserLvl');
  const name = state.container.querySelector('#mmUserName');
  const avatar = state.container.querySelector('#mmAvatar');
  const xpEl = state.container.querySelector('#mmUserXp');
  if (lvl) lvl.textContent = `LVL ${p.level}`;
  if (name) name.textContent = p.playerName;
  if (avatar) avatar.textContent = p.playerName.substring(0, 2).toUpperCase();
  if (xpEl) xpEl.textContent = `· ${xp.current.toLocaleString()} / ${xp.needed.toLocaleString()} XP`;

  wireTabEvents();
}

// ─────────────────────────────────────────────────────────────────────
//  EVENT WIRING
// ─────────────────────────────────────────────────────────────────────

function wireTabEvents(): void {
  if (!state.container) return;

  // Tab navigation
  state.container.querySelectorAll('.mn-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = (btn as HTMLElement).dataset.tab as any;
      state.container!.querySelectorAll('.mn-tab').forEach(t => t.classList.remove('on'));
      btn.classList.add('on');
      refresh();
    });
  });

  // Mode selection (PLAY tab only)
  state.container.querySelectorAll('.mn-mode').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedMode = (card as HTMLElement).dataset.mode as GameMode;
      state.container!.querySelectorAll('.mn-mode').forEach(c => c.classList.remove('on'));
      card.classList.add('on');
      // Update deploy label without full refresh
      const deploy = state.container!.querySelector('#mmDeploy .mn-deploy-label');
      if (deploy) {
        deploy.textContent = state.selectedMode === 'training' ? 'ENTER TRAINING RANGE' : 'INITIATE MATCH';
      }
    });
  });

  // Deploy button (PLAY tab only)
  const deployBtn = state.container.querySelector('#mmDeploy');
  if (deployBtn) {
    deployBtn.addEventListener('click', () => {
      if (state.selectedMode === 'training') {
        state.onTraining?.();
      } else {
        state.onStart?.(state.selectedMode, state.editingLoadoutIndex);
      }
      hideMainMenu();
    });
  }

  // Quit
  const quitBtn = state.container.querySelector('#mmQuit');
  if (quitBtn) {
    quitBtn.addEventListener('click', () => hideMainMenu());
  }

  // Prestige (CAREER tab)
  const prestigeBtn = state.container.querySelector('#prestigeBtn');
  if (prestigeBtn) {
    prestigeBtn.addEventListener('click', () => { prestige(); refresh(); });
  }

  // Claim all (CONTRACTS tab center)
  const claimBtn = state.container.querySelector('#claimAllBtn');
  if (claimBtn) {
    claimBtn.addEventListener('click', () => { claimAllCompleted(); refresh(); });
  }

  // Claim all (right col sidebar)
  const claimBtnRight = state.container.querySelector('#claimAllBtnRight');
  if (claimBtnRight) {
    claimBtnRight.addEventListener('click', () => { claimAllCompleted(); refresh(); });
  }

  // Loadout selection (LOADOUT tab)
  state.container.querySelectorAll('.mm-loadout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.editingLoadoutIndex = parseInt((btn as HTMLElement).dataset.loadoutIdx ?? '0');
      refresh();
    });
  });

  // Equip loadout
  const equipBtn = state.container.querySelector('#equipLoadoutBtn');
  if (equipBtn) {
    equipBtn.addEventListener('click', () => { setActiveLoadout(state.editingLoadoutIndex); refresh(); });
  }

  // Loadout name edit
  const nameInput = state.container.querySelector('#loadoutName') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim().substring(0, 20);
      if (name) updateLoadout(state.editingLoadoutIndex, { name });
    });
  }

  // Settings sliders
  const sliders: [string, string][] = [
    ['sMaster', 'sMasterVal'], ['sMusic', 'sMusicVal'],
    ['sSfx', 'sSfxVal'], ['sVoice', 'sVoiceVal'],
    ['sFov', 'sFovVal'], ['sSens', 'sSensVal'], ['sAds', 'sAdsVal'],
  ];
  for (const [id, valId] of sliders) {
    const slider = state.container.querySelector(`#${id}`) as HTMLInputElement | null;
    const valEl = state.container.querySelector(`#${valId}`);
    if (slider && valEl) {
      slider.addEventListener('input', () => {
        if (id === 'sAds') {
          valEl.textContent = (parseInt(slider.value) / 10).toFixed(1);
        } else if (['sMaster', 'sMusic', 'sSfx', 'sVoice'].includes(id)) {
          valEl.textContent = slider.value + '%';
        } else {
          valEl.textContent = slider.value;
        }
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────

export function initMainMenu(
  onStart: (mode: GameMode, loadoutIndex: number) => void,
  onTraining?: () => void,
): void {
  state.onStart = onStart;
  state.onTraining = onTraining ?? null;
  state.container = build();

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
