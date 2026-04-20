/**
 * MainMenu — career-driven main menu UI.
 *
 * Replaces whatever simple "Start Game" button exists with a full-featured
 * main menu that ties together:
 *   - Career (level, XP, unlocks, career stats, prestige button)
 *   - Play (mode selector: TDM, FFA, CTF, Domination, Hardpoint, KoTH, S&D, BR, Training)
 *   - Loadouts (5 slots, perk/lethal/tactical/field upgrade editor)
 *   - Contracts (daily/weekly, claim rewards)
 *   - Cosmetics (equipped operator/weapon skins/emotes/sprays/finisher/intro)
 *   - Settings (audio, graphics, controls)
 *
 * Uses the frontend-design Claude skill aesthetic — dark, high-contrast,
 * tactical HUD vibe. No external UI library.
 *
 * Integration:
 *   - Call initMainMenu(onStart) once at bootstrap
 *   - showMainMenu() / hideMainMenu() on match end / start
 *   - onStart callback is fired with (mode, loadoutIndex) when user clicks Start
 */

import {
  getProfile, subscribeProfile, getXpProgress, getOverallKD, getWinRate,
  MAX_LEVEL, prestige, awardAccountXP, profileMutate,
} from '@/core/PlayerProfile';
import { getLoadouts, getActiveLoadout, setActiveLoadout, updateLoadout,
  PERKS, FIELD_UPGRADES, LETHALS, TACTICALS, isPerkUnlocked } from '@/config/Loadouts';
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
//  TAB RENDERERS
// ─────────────────────────────────────────────────────────────────────

const MODES: Array<{ id: GameMode; name: string; subtitle: string; players: string; icon: string }> = [
  { id: 'tdm',         name: 'Team Deathmatch', subtitle: 'Classic 6v6 with respawns',     players: '6v6', icon: '⚔' },
  { id: 'ffa',         name: 'Free-For-All',    subtitle: 'Every player for themselves',   players: '8P',  icon: '✷' },
  { id: 'domination',  name: 'Domination',      subtitle: 'Capture and hold 3 zones',      players: '6v6', icon: '◣' },
  { id: 'hardpoint',   name: 'Hardpoint',       subtitle: 'Hold the rotating hill',        players: '6v6', icon: '⌘' },
  { id: 'koth',        name: 'King of the Hill',subtitle: 'Hold the crown — 3 min win',    players: '6v6', icon: '♛' },
  { id: 'sd',          name: 'Search & Destroy',subtitle: 'Plant/defuse · No respawns',    players: '5v5', icon: '⌖' },
  { id: 'ctf',         name: 'Capture the Flag',subtitle: 'Retrieve the enemy flag',       players: '6v6', icon: '⚑' },
  { id: 'br',          name: 'Battle Royale',   subtitle: '30-player last-man-standing',   players: '30P', icon: '◉' },
  { id: 'training',    name: 'Training Range',  subtitle: 'Targets · Tutorial · Solo',     players: '1P',  icon: '◈' },
];

function renderPlayTab(): string {
  return `
    <div class="mm-play-grid">
      ${MODES.map(m => `
        <div class="mm-mode-card ${state.selectedMode === m.id ? 'selected' : ''}" data-mode="${m.id}">
          <div class="mm-mode-icon">${m.icon}</div>
          <div class="mm-mode-title">${m.name}</div>
          <div class="mm-mode-sub">${m.subtitle}</div>
          <div class="mm-mode-meta">${m.players}</div>
        </div>
      `).join('')}
    </div>
  `;
}

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

function renderLoadoutTab(): string {
  const loadouts = getLoadouts();
  const editing = loadouts[state.editingLoadoutIndex];
  if (!editing) return '<div class="mm-empty">No loadouts</div>';

  const perkRow = (slot: 'perk1' | 'perk2' | 'perk3', perkGroup: number) => {
    const perkKey = slot as keyof typeof editing;
    const selectedId = editing[perkKey] as string;
    const perkDef = PERKS.find(p => p.id === selectedId);
    const availablePerks = PERKS.filter(p => p.slot === perkGroup + 1);
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

function renderContractsTab(): string {
  const dailies = getContracts('daily');
  const weeklies = getContracts('weekly');

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
      <div class="mm-contract-title-main">ACTIVE CONTRACTS (${(() => { const cc = getActiveContractCount(); return cc.daily + cc.weekly; })()})</div>
      <button class="mm-btn mm-btn-primary" id="claimAllBtn">CLAIM ALL</button>
    </div>
    <div class="mm-section-head">DAILY · Resets in 24h</div>
    <div class="mm-contracts-grid">${dailies.map(contractRow).join('')}</div>
    <div class="mm-section-head">WEEKLY · Resets Monday</div>
    <div class="mm-contracts-grid">${weeklies.map(contractRow).join('')}</div>
  `;
}

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

function renderSettingsTab(): string {
  return `
    <div class="mm-settings">
      <div class="mm-setting-group">
        <div class="mm-section-head">AUDIO</div>
        <div class="mm-setting-row">
          <label>Master Volume</label>
          <input type="range" min="0" max="100" value="80" id="sMaster"/>
          <span id="sMasterVal">80%</span>
        </div>
        <div class="mm-setting-row">
          <label>Music</label>
          <input type="range" min="0" max="100" value="60" id="sMusic"/>
          <span id="sMusicVal">60%</span>
        </div>
        <div class="mm-setting-row">
          <label>SFX</label>
          <input type="range" min="0" max="100" value="90" id="sSfx"/>
          <span id="sSfxVal">90%</span>
        </div>
        <div class="mm-setting-row">
          <label>Voice Callouts</label>
          <input type="range" min="0" max="100" value="75" id="sVoice"/>
          <span id="sVoiceVal">75%</span>
        </div>
      </div>

      <div class="mm-setting-group">
        <div class="mm-section-head">GRAPHICS</div>
        <div class="mm-setting-row">
          <label>FOV</label>
          <input type="range" min="60" max="110" value="75" id="sFov"/>
          <span id="sFovVal">75</span>
        </div>
        <div class="mm-setting-row">
          <label>Shadows</label>
          <select id="sShadows">
            <option>Low</option><option selected>Medium</option><option>High</option>
          </select>
        </div>
        <div class="mm-setting-row">
          <label>Particles</label>
          <select id="sParticles">
            <option>Low</option><option selected>Medium</option><option>High</option>
          </select>
        </div>
      </div>

      <div class="mm-setting-group">
        <div class="mm-section-head">CONTROLS</div>
        <div class="mm-setting-row">
          <label>Mouse Sensitivity</label>
          <input type="range" min="1" max="20" value="8" id="sSens"/>
          <span id="sSensVal">8</span>
        </div>
        <div class="mm-setting-row">
          <label>ADS Sensitivity Mult</label>
          <input type="range" min="5" max="15" value="10" id="sAds"/>
          <span id="sAdsVal">1.0</span>
        </div>
        <div class="mm-setting-row">
          <label>Invert Y</label>
          <input type="checkbox" id="sInvert"/>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
//  BUILD / ATTACH
// ─────────────────────────────────────────────────────────────────────

function build(): HTMLDivElement {
  const root = document.createElement('div');
  root.id = 'mainMenuRoot';
  root.innerHTML = `
    <div class="mm-bg"></div>
    <div class="mm-shell">
      <header class="mm-header">
        <div class="mm-brand">
          <span class="mm-brand-tag">◢</span>
          <span class="mm-brand-name">WARZONE TDM</span>
        </div>
        <nav class="mm-tabs">
          ${['play', 'career', 'loadout', 'contracts', 'cosmetics', 'settings'].map(t =>
            `<button class="mm-tab ${state.activeTab === t ? 'active' : ''}" data-tab="${t}">${t.toUpperCase()}</button>`
          ).join('')}
        </nav>
        <div class="mm-user-strip">
          <span class="mm-user-lvl" id="mmUserLvl"></span>
          <span class="mm-user-name" id="mmUserName"></span>
        </div>
      </header>

      <main class="mm-main" id="mmContent">
        <!-- tab content injected here -->
      </main>

      <footer class="mm-footer">
        <button class="mm-btn mm-btn-secondary" id="mmQuit">QUIT</button>
        <div class="mm-notifs" id="mmNotifs"></div>
        <button class="mm-btn mm-btn-huge mm-btn-primary" id="mmPlay">▶ START MATCH</button>
      </footer>
    </div>
  `;
  document.body.appendChild(root);

  injectStyles();
  return root;
}

function injectStyles(): void {
  if (document.getElementById('mainMenuStyle')) return;
  const s = document.createElement('style');
  s.id = 'mainMenuStyle';
  s.textContent = `
    #mainMenuRoot {
      position: fixed; inset: 0;
      z-index: 20;
      font-family: var(--body-font);
      color: var(--bone);
      background:
        linear-gradient(180deg, rgba(6,7,11,0.75) 0%, rgba(6,7,11,0.92) 100%),
        url('/images/MainMenuBackground.png') center/cover no-repeat,
        radial-gradient(ellipse at center, var(--steel-900) 0%, var(--void) 80%);
      display: none;
    }
    #mainMenuRoot.active { display: block; }

    .mm-bg {
      position: absolute; inset: 0;
      background:
        radial-gradient(ellipse at 70% 20%, rgba(255,140,26,0.06) 0%, transparent 50%),
        radial-gradient(ellipse at 20% 80%, rgba(57,240,255,0.04) 0%, transparent 40%);
      pointer-events: none;
    }
    .mm-bg::before {
      content: ''; position: absolute; inset: 0;
      background-image:
        linear-gradient(rgba(255,140,26,.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,140,26,.03) 1px, transparent 1px);
      background-size: 60px 60px;
      mask-image: radial-gradient(ellipse at center, black 20%, transparent 80%);
    }

    .mm-shell {
      position: relative; max-width: 1400px; height: 100vh;
      margin: 0 auto; display: flex; flex-direction: column;
    }

    /* HEADER */
    .mm-header {
      display: flex; align-items: center; gap: 28px;
      padding: 16px 32px;
      border-bottom: 1px solid var(--hairline);
    }
    .mm-brand { display: flex; align-items: center; gap: 10px; }
    .mm-brand-tag { color: var(--signal); font-size: 22px; font-family: var(--display-font); }
    .mm-brand-name {
      font-family: var(--tactical-font);
      font-size: 13px; font-weight: 700;
      letter-spacing: 0.3em; color: var(--bone);
    }
    .mm-tabs { display: flex; gap: 2px; flex: 1; justify-content: center; }
    .mm-tab {
      background: transparent; border: none; border-bottom: 2px solid transparent;
      color: var(--muted);
      font-family: var(--mono-font);
      font-size: 11px; font-weight: 500;
      letter-spacing: 0.3em;
      padding: 12px 22px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .mm-tab:hover { color: var(--bone); }
    .mm-tab.active { color: var(--signal); border-bottom-color: var(--signal); }
    .mm-user-strip { display: flex; align-items: center; gap: 10px; }
    .mm-user-lvl {
      background: rgba(255,140,26,0.15);
      color: var(--signal);
      padding: 4px 12px;
      font-family: var(--mono-font);
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.2em;
    }
    .mm-user-name {
      font-family: var(--tactical-font);
      font-size: 12px; font-weight: 700;
      letter-spacing: 0.15em; color: var(--bone);
    }

    /* MAIN */
    .mm-main { flex: 1; padding: 28px 32px; overflow-y: auto; }

    /* FOOTER */
    .mm-footer {
      display: flex; align-items: center; gap: 16px;
      padding: 16px 32px;
      border-top: 1px solid var(--hairline);
      background: rgba(6,7,11,0.4);
    }
    .mm-notifs {
      flex: 1;
      font-family: var(--mono-font);
      font-size: 11px; letter-spacing: 0.15em; color: var(--muted);
    }
    .mm-btn {
      background: var(--steel-800);
      color: var(--bone);
      border: 1px solid var(--hairline-strong);
      padding: 12px 24px;
      font-family: var(--tactical-font);
      font-size: 12px; font-weight: 700;
      letter-spacing: 0.25em;
      cursor: pointer;
      transition: all 0.15s var(--ease-out-expo);
    }
    .mm-btn:hover { border-color: var(--signal); color: var(--signal); }
    .mm-btn-primary {
      background: var(--signal);
      color: var(--void);
      border-color: var(--signal);
      clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 100%, 0 100%);
    }
    .mm-btn-primary:hover { filter: brightness(1.12); color: var(--void); transform: translateX(6px); }
    .mm-btn-huge { padding: 16px 52px; font-size: 15px; }
    .mm-btn-secondary { background: transparent; border-color: var(--hairline); }

    /* TAB: PLAY */
    .mm-play-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .mm-mode-card {
      background: var(--steel-900);
      border: 1px solid var(--hairline);
      border-top: 2px solid transparent;
      padding: 18px 20px;
      cursor: pointer;
      transition: border 0.2s, background 0.2s, transform 0.2s var(--ease-out-expo);
      position: relative;
    }
    .mm-mode-card:hover { border-color: var(--hairline-strong); border-top-color: var(--signal); transform: translateY(-2px); }
    .mm-mode-card.selected {
      border-top-color: var(--signal);
      background: linear-gradient(180deg, rgba(255,140,26,0.1), var(--steel-900) 40%);
    }
    .mm-mode-icon { font-size: 28px; color: var(--signal); margin-bottom: 12px; font-family: var(--display-font); }
    .mm-mode-title { font-family: var(--tactical-font); font-size: 13px; font-weight: 700; letter-spacing: 0.1em; color: var(--bone); }
    .mm-mode-sub { font-family: var(--body-font); font-size: 11px; color: var(--muted); margin-top: 5px; line-height: 1.4; }
    .mm-mode-meta { font-family: var(--mono-font); font-size: 10px; color: var(--signal); letter-spacing: 0.3em; margin-top: 10px; }

    /* TAB: CAREER */
    .mm-career-head { display: flex; gap: 24px; align-items: center; margin-bottom: 28px; }
    .mm-avatar {
      width: 80px; height: 80px;
      background: var(--steel-800);
      border: 1px solid var(--signal);
      display: grid; place-items: center;
      font-family: var(--display-font);
      font-size: 32px; font-weight: 400;
      color: var(--signal); position: relative;
    }
    .mm-avatar::before, .mm-avatar::after {
      content: ''; position: absolute;
      width: 8px; height: 8px; border: 1px solid var(--signal);
    }
    .mm-avatar::before { top: -2px; left: -2px; border-right: 0; border-bottom: 0; }
    .mm-avatar::after  { bottom: -2px; right: -2px; border-left: 0; border-top: 0; }
    .mm-career-name { flex: 1; }
    .mm-career-username { font-family: var(--display-font); font-size: 28px; font-weight: 400; letter-spacing: -.01em; color: var(--bone); }
    .mm-career-level { display: flex; align-items: center; gap: 12px; margin: 8px 0; }
    .mm-level-pill {
      background: rgba(255,140,26,0.15); color: var(--signal);
      padding: 4px 12px; font-family: var(--mono-font);
      font-size: 11px; font-weight: 700; letter-spacing: 0.2em;
    }
    .mm-level-sub { font-family: var(--mono-font); font-size: 11px; color: var(--muted); letter-spacing: 0.12em; }
    .mm-xp-bar { height: 4px; width: 100%; max-width: 480px; background: var(--steel-700); }
    .mm-xp-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--signal-dim), var(--signal), var(--signal-hot));
      transition: width 0.4s ease-out;
      box-shadow: 0 0 8px var(--signal-glow);
    }
    .mm-prestige-section {
      background: linear-gradient(135deg, rgba(194,123,255,0.1), transparent 70%);
      border: 1px solid rgba(194,123,255,0.3);
      border-left: 3px solid var(--purple);
      padding: 16px 20px; margin-bottom: 24px;
    }
    .mm-prestige-title { font-family: var(--tactical-font); color: var(--purple); font-size: 12px; font-weight: 700; letter-spacing: 0.3em; margin-bottom: 6px; }
    .mm-prestige-desc { font-family: var(--body-font); font-size: 12px; color: var(--text-dim); margin-bottom: 12px; }

    .mm-stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 24px; }
    .mm-stat { background: var(--steel-900); border: 1px solid var(--hairline); border-left: 3px solid var(--signal); padding: 10px 14px; }
    .mm-stat-label { font-family: var(--mono-font); font-size: 9px; letter-spacing: 0.25em; color: var(--muted); }
    .mm-stat-val { font-family: var(--display-font); font-size: 22px; font-weight: 400; color: var(--bone); margin-top: 4px; }

    .mm-section-head {
      font-family: var(--mono-font); font-size: 10px; letter-spacing: 0.35em;
      color: var(--signal); font-weight: 700;
      margin: 20px 0 10px; padding-bottom: 8px;
      border-bottom: 1px solid var(--hairline);
      display: flex; align-items: center; gap: 8px;
    }
    .mm-section-head::before { content: ''; width: 3px; height: 12px; background: var(--signal); }

    .mm-weapons { display: flex; flex-direction: column; gap: 4px; }
    .mm-weapon-row { display: grid; grid-template-columns: 160px 52px 1fr 60px; gap: 12px; align-items: center; background: var(--steel-900); padding: 7px 14px; }
    .mm-weapon-name { font-family: var(--tactical-font); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: var(--bone); }
    .mm-weapon-lvl { font-family: var(--mono-font); color: var(--signal); font-size: 11px; font-weight: 700; }
    .mm-weapon-bar { height: 3px; background: var(--steel-700); }
    .mm-weapon-fill { height: 100%; background: linear-gradient(90deg, var(--signal-dim), var(--signal)); }
    .mm-weapon-kills { font-family: var(--mono-font); text-align: right; color: var(--muted); font-size: 11px; }

    /* TAB: LOADOUT */
    .mm-loadouts-list { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
    .mm-loadout-btn {
      background: var(--steel-900); border: 1px solid var(--hairline);
      padding: 10px 18px; cursor: pointer;
      font-family: var(--mono-font); font-size: 11px; font-weight: 600;
      letter-spacing: 0.2em; color: var(--text-dim); transition: all 0.15s;
    }
    .mm-loadout-btn:hover { border-color: var(--signal); color: var(--signal); }
    .mm-loadout-btn.active { border-color: var(--signal); color: var(--signal); background: rgba(255,140,26,0.1); }
    .mm-loadout-btn.equipped { border-color: var(--toxic); color: var(--toxic); background: rgba(184,255,61,0.07); }
    .mm-loadout-editor { background: var(--steel-900); border: 1px solid var(--hairline); padding: 24px; }
    .mm-le-name {
      background: transparent; color: var(--bone);
      border: none; border-bottom: 1px solid var(--hairline);
      font-family: var(--tactical-font);
      font-size: 18px; font-weight: 700; letter-spacing: 0.1em;
      width: 100%; padding: 6px 0; margin-bottom: 20px;
    }
    .mm-le-name:focus { outline: none; border-bottom-color: var(--signal); }
    .mm-slots-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .mm-slot-row { display: flex; flex-direction: column; gap: 4px; }
    .mm-slot-label { font-family: var(--mono-font); font-size: 9px; letter-spacing: 0.3em; color: var(--muted); }
    .mm-slot-btn {
      background: var(--steel-800); color: var(--bone);
      border: 1px solid var(--hairline); padding: 10px 14px; cursor: pointer;
      font-family: var(--body-font); font-size: 12px; font-weight: 600;
      text-align: left; transition: all 0.15s;
    }
    .mm-slot-btn:hover { border-color: var(--signal); color: var(--signal); }
    .mm-perks-grid { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .mm-perk-chip {
      background: var(--steel-800); border: 1px solid var(--hairline);
      padding: 4px 10px; cursor: pointer;
      font-family: var(--mono-font); font-size: 10px; letter-spacing: 0.15em; color: var(--text-dim);
      transition: all 0.12s;
    }
    .mm-perk-chip:hover { border-color: var(--signal); color: var(--signal); }
    .mm-perk-chip.selected { background: rgba(255,140,26,0.15); border-color: var(--signal); color: var(--signal); }
    .mm-perk-chip.locked { opacity: 0.35; cursor: not-allowed; }
    .mm-perk-chip.locked:hover { border-color: var(--hairline); color: var(--text-dim); }

    /* TAB: CONTRACTS */
    .mm-contracts { display: flex; flex-direction: column; gap: 12px; }
    .mm-contract-section { margin-bottom: 8px; }
    .mm-contract-item {
      background: var(--steel-900); border: 1px solid var(--hairline);
      padding: 14px 18px; display: flex; align-items: center; gap: 14px; position: relative;
    }
    .mm-contract-item.done { border-left: 3px solid var(--toxic); }
    .mm-ci-icon { font-size: 20px; min-width: 28px; text-align: center; }
    .mm-ci-info { flex: 1; }
    .mm-ci-label { font-family: var(--body-font); font-size: 13px; font-weight: 600; letter-spacing: 0.08em; color: var(--bone); }
    .mm-ci-prog { height: 3px; background: var(--steel-700); margin-top: 6px; overflow: hidden; }
    .mm-ci-prog-fill { height: 100%; background: var(--signal); box-shadow: 0 0 4px var(--signal-glow); transition: width 0.3s ease; }
    .mm-ci-xp { font-family: var(--mono-font); font-size: 12px; font-weight: 700; color: var(--signal-hot); letter-spacing: 0.15em; }

    /* TAB: COSMETICS */
    .mm-cos-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
    .mm-cos-section { background: var(--steel-900); border: 1px solid var(--hairline); padding: 14px 16px; }
    .mm-cos-row { display: flex; justify-content: space-between; padding: 4px 0; font-family: var(--body-font); font-size: 12px; }
    .mm-cos-label { color: var(--muted); }
    .mm-cos-val { font-weight: 700; color: var(--bone); }
    .mm-cos-emotes { display: flex; gap: 6px; }
    .mm-cos-slot { background: var(--steel-800); padding: 8px 12px; text-align: center; border: 1px solid var(--hairline); flex: 1; }
    .mm-cos-slot-num { font-family: var(--mono-font); font-size: 9px; color: var(--muted); margin-bottom: 4px; letter-spacing: 0.2em; }
    .mm-cos-slot-val { font-family: var(--body-font); font-size: 11px; font-weight: 700; color: var(--bone); }
    .mm-cos-unlocks { display: flex; gap: 16px; font-family: var(--mono-font); font-size: 11px; color: var(--text-dim); letter-spacing: 0.1em; }
    .mm-cos-unlock { grid-column: span 2; }

    /* TAB: SETTINGS */
    .mm-settings { max-width: 640px; }
    .mm-setting-group { margin-bottom: 24px; }
    .mm-setting-row { display: grid; grid-template-columns: 200px 1fr 52px; align-items: center; gap: 14px; padding: 7px 0; }
    .mm-setting-row label { font-family: var(--mono-font); font-size: 10px; letter-spacing: 0.25em; color: var(--text-dim); }
    .mm-setting-row input[type="range"] { accent-color: var(--signal); }
    .mm-setting-row select { background: var(--steel-800); color: var(--bone); border: 1px solid var(--hairline); padding: 6px 10px; font-family: var(--mono-font); font-size: 11px; }
    .mm-setting-row input[type="checkbox"] { accent-color: var(--signal); width: 18px; height: 18px; }
    .mm-setting-row span { font-family: var(--mono-font); min-width: 40px; text-align: right; font-size: 11px; color: var(--signal); letter-spacing: 0.1em; }

    /* Legacy badge styles */
    .mm-badge {
      font-family: var(--mono-font);
      font-size: 9px; font-weight: 700;
      padding: 2px 8px; letter-spacing: 0.2em;
    }
    .mm-badge-active { background: rgba(255,140,26,0.15); color: var(--signal); }
    .mm-badge-equipped { background: rgba(184,255,61,0.15); color: var(--toxic); }

    .mm-empty { text-align: center; color: var(--muted); font-family: var(--mono-font); padding: 60px 0; font-size: 13px; letter-spacing: 0.25em; }
  
  `;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────
//  REFRESH / EVENT WIRING
// ─────────────────────────────────────────────────────────────────────

function refresh(): void {
  if (!state.container) return;
  const content = state.container.querySelector('#mmContent');
  if (!content) return;

  switch (state.activeTab) {
    case 'play':      content.innerHTML = renderPlayTab(); break;
    case 'career':    content.innerHTML = renderCareerTab(); break;
    case 'loadout':   content.innerHTML = renderLoadoutTab(); break;
    case 'contracts': content.innerHTML = renderContractsTab(); break;
    case 'cosmetics': content.innerHTML = renderCosmeticsTab(); break;
    case 'settings':  content.innerHTML = renderSettingsTab(); break;
  }

  // Update header user strip
  const p = getProfile();
  const lvl = state.container.querySelector('#mmUserLvl');
  const name = state.container.querySelector('#mmUserName');
  if (lvl) lvl.textContent = `LVL ${p.level}`;
  if (name) name.textContent = p.playerName;

  wireTabEvents();
}

function wireTabEvents(): void {
  if (!state.container) return;

  // Tab navigation
  state.container.querySelectorAll('.mm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = (btn as HTMLElement).dataset.tab as any;
      state.container!.querySelectorAll('.mm-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      refresh();
    });
  });

  // Mode selection
  state.container.querySelectorAll('.mm-mode-card').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedMode = (card as HTMLElement).dataset.mode as GameMode;
      state.container!.querySelectorAll('.mm-mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });

  // Start button
  const playBtn = state.container.querySelector('#mmPlay');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (state.selectedMode === 'training') {
        state.onTraining?.();
      } else {
        state.onStart?.(state.selectedMode, state.editingLoadoutIndex);
      }
      hideMainMenu();
    });
  }

  // Quit button (just hides menu)
  const quitBtn = state.container.querySelector('#mmQuit');
  if (quitBtn) {
    quitBtn.addEventListener('click', () => hideMainMenu());
  }

  // Prestige button
  const prestigeBtn = state.container.querySelector('#prestigeBtn');
  if (prestigeBtn) {
    prestigeBtn.addEventListener('click', () => {
      prestige();
      refresh();
    });
  }

  // Claim all contracts
  const claimBtn = state.container.querySelector('#claimAllBtn');
  if (claimBtn) {
    claimBtn.addEventListener('click', () => {
      claimAllCompleted();
      refresh();
    });
  }

  // Loadout selection
  state.container.querySelectorAll('.mm-loadout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.editingLoadoutIndex = parseInt((btn as HTMLElement).dataset.loadoutIdx ?? '0');
      refresh();
    });
  });

  // Equip loadout
  const equipBtn = state.container.querySelector('#equipLoadoutBtn');
  if (equipBtn) {
    equipBtn.addEventListener('click', () => {
      setActiveLoadout(state.editingLoadoutIndex);
      refresh();
    });
  }

  // Loadout name edit
  const nameInput = state.container.querySelector('#loadoutName') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim().substring(0, 20);
      if (name) {
        updateLoadout(state.editingLoadoutIndex, { name });
      }
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
        } else if (id === 'sMaster' || id === 'sMusic' || id === 'sSfx' || id === 'sVoice') {
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

  // React to profile changes
  state.unsubscribe = subscribeProfile(() => {
    if (state.visible) refresh();
  });
}

export function showMainMenu(): void {
  if (!state.container) return;
  state.visible = true;
  state.activeTab = 'play';
  state.container.classList.add('active');
  // Safety net: whenever the MainMenu is on screen, the body is NOT
  // "in a match". This guarantees the CLICK-TO-DEPLOY lockHint banner
  // (z-index 30) stays hidden — CSS keys off `body.in-match`.
  document.body.classList.remove('in-match');
  refresh();
  document.exitPointerLock?.();
}

export function hideMainMenu(): void {
  if (!state.container) return;
  state.visible = false;
  state.container.classList.remove('active');
}