/**
 * HUD — APEX PROTOCOL in-match HUD driver.
 *
 * Writes to the preview's real selectors:
 *   Vitals:      .hv-hp-seg / .hv-armor-seg (10 segments each) + #hpVal / #armorVal
 *   Dock:        .dk-slot.active + .dk-wep-svg
 *   Ammo:        .ha-mag / .ha-reserve / .ha-mag-dots span / .ha-reload-hint
 *   Match:       .hm-timer / .hm-mode / .hm-team-score
 *   Kill feed:   .hud-killfeed > .kf-row > .kf-killer / .kf-wep / .kf-hs / .kf-victim
 *   Crosshair:   #xh (live runtime crosshair, not the static preview one)
 *
 * Public API preserved for main.ts + GameLoop:
 *   updateHUD()
 *   updateCrosshair()
 *   flashCrosshairFire()
 *   flashDmg(dmg?)
 *   flashHeal()
 *   updateCookTimer()
 *   pushKillFeed(entry)           — NEW, replaces KillFeed.ts's DOM writes
 *   updateMatchInfo(...)          — drives .hm-* (called from mode logic)
 */

import { gameState } from '@/core/GameState';
import { WEAPONS, type WeaponId } from '@/config/weapons';
import { getPlayerInventory } from '@/br/InventoryUI';
import { GLYPHS } from './Glyphs';
import { getWeaponIconSVG, getWeaponModeLabel } from './WeaponIcons';
import { getProfile } from '@/core/PlayerProfile';

// ── DOM cache ───────────────────────────────────────────────────────────
interface ApexDOM {
  hpBar: HTMLElement | null;
  hpVal: HTMLElement | null;
  armorBar: HTMLElement | null;
  armorVal: HTMLElement | null;
  hvRank: HTMLElement | null;
  hvName: HTMLElement | null;
  haWepName: HTMLElement | null;
  haWepMode: HTMLElement | null;
  haMag: HTMLElement | null;
  haReserve: HTMLElement | null;
  haMagDots: HTMLElement | null;
  haReloadHint: HTMLElement | null;
  dkSlots: (HTMLElement | null)[];
  dkSvgs: (HTMLElement | null)[];
  hmMode: HTMLElement | null;
  hmTimer: HTMLElement | null;
  hmScoreBlue: HTMLElement | null;
  hmScoreRed: HTMLElement | null;
  killfeed: HTMLElement | null;
  dmg: HTMLElement | null;
  hlf: HTMLElement | null;
  xh: HTMLElement | null;
  scope: HTMLElement | null;
}

let dom: ApexDOM | null = null;
let hpSegments: HTMLElement[] = [];
let armorSegments: HTMLElement[] = [];
let magDotEls: HTMLElement[] = [];
let lastMagSize = -1;
const lastSlotWep: (WeaponId | null)[] = [null, null, null];
let lastKnownActiveSlot = -1;
let glyphsInjected = false;

function cacheDOM(): ApexDOM {
  if (dom) return dom;
  dom = {
    hpBar:        document.getElementById('hpBar'),
    hpVal:        document.getElementById('hpVal'),
    armorBar:     document.getElementById('armorBar'),
    armorVal:     document.getElementById('armorVal'),
    hvRank:       document.getElementById('hvRank'),
    hvName:       document.getElementById('hvName'),
    haWepName:    document.getElementById('haWepName'),
    haWepMode:    document.getElementById('haWepMode'),
    haMag:        document.getElementById('haMag'),
    haReserve:    document.getElementById('haReserve'),
    haMagDots:    document.getElementById('haMagDots'),
    haReloadHint: document.getElementById('haReloadHint'),
    dkSlots: [
      document.getElementById('dkSlot0'),
      document.getElementById('dkSlot1'),
      document.getElementById('dkSlot2'),
    ],
    dkSvgs: [
      document.getElementById('dkSvg0'),
      document.getElementById('dkSvg1'),
      document.getElementById('dkSvg2'),
    ],
    hmMode:       document.getElementById('hmMode'),
    hmTimer:      document.getElementById('hmTimer'),
    hmScoreBlue:  document.getElementById('hmScoreBlue'),
    hmScoreRed:   document.getElementById('hmScoreRed'),
    killfeed:     document.getElementById('killfeed'),
    dmg:          document.getElementById('dmg'),
    hlf:          document.getElementById('hlf'),
    xh:           document.getElementById('xh'),
    scope:        document.getElementById('scopeOverlay'),
  };
  return dom;
}

/** Build the 10 HP segments + 10 armor segments on first tick. */
function ensureSegments(): void {
  const d = cacheDOM();
  if (hpSegments.length === 0 && d.hpBar) {
    for (let i = 0; i < 10; i++) {
      const seg = document.createElement('div');
      seg.className = 'hv-hp-seg';
      d.hpBar.appendChild(seg);
      hpSegments.push(seg);
    }
  }
  if (armorSegments.length === 0 && d.armorBar) {
    for (let i = 0; i < 10; i++) {
      const seg = document.createElement('div');
      seg.className = 'hv-armor-seg';
      d.armorBar.appendChild(seg);
      armorSegments.push(seg);
    }
  }
}

/** Build the mag-dot indicators whenever the mag size changes. */
function rebuildMagDots(magSize: number): void {
  const d = cacheDOM();
  if (!d.haMagDots) return;
  if (magSize === lastMagSize) return;

  d.haMagDots.innerHTML = '';
  magDotEls.length = 0;
  // Cap at 30 dots so a 100-round drum doesn't blow out the right side.
  const dotCount = Math.min(30, Math.max(1, magSize));
  for (let i = 0; i < dotCount; i++) {
    const dot = document.createElement('span');
    d.haMagDots.appendChild(dot);
    magDotEls.push(dot);
  }
  lastMagSize = magSize;
}

function injectHudGlyphsOnce(): void {
  if (glyphsInjected) return;
  // The preview has <svg> glyphs inline in the static HTML for dock slots.
  // Our live HUD populates them from weapon icons each frame, so there's
  // nothing to seed here — but if we later add named icon slots this is
  // the single injection point.
  glyphsInjected = true;
}

// ── MAIN TICK ───────────────────────────────────────────────────────────
export function updateHUD(): void {
  injectHudGlyphsOnce();
  ensureSegments();
  const d = cacheDOM();

  // ── HP / Armor segments ────────────────────────────────────────────
  const hpPct = Math.max(0, Math.min(100, gameState.pHP ?? 0));
  const hpOn = Math.round(hpPct / 10);
  for (let i = 0; i < hpSegments.length; i++) {
    const seg = hpSegments[i];
    const on = i < hpOn;
    // Toggle .on only when state changes to avoid style thrash
    if (on !== seg.classList.contains('on')) seg.classList.toggle('on', on);
    // Tier color: crit (red, pulsing) < 20, low (amber) < 40, normal (toxic)
    if (on) {
      const crit = hpPct < 20;
      const low  = hpPct < 40 && !crit;
      if (crit !== seg.classList.contains('crit')) seg.classList.toggle('crit', crit);
      if (low  !== seg.classList.contains('low'))  seg.classList.toggle('low',  low);
    } else if (seg.classList.contains('crit') || seg.classList.contains('low')) {
      seg.classList.remove('crit', 'low');
    }
  }
  if (d.hpVal) d.hpVal.textContent = String(Math.round(hpPct));

  // Armor — from BR inventory (if BR mode) else flat 0.
  let armorHP = 0, armorMax = 100;
  if (gameState.mode === 'br') {
    const inv = getPlayerInventory();
    if (inv) { armorHP = inv.armorHP ?? 0; armorMax = inv.maxArmorHP || 100; }
  }
  const armorOn = Math.round((armorHP / Math.max(1, armorMax)) * 10);
  for (let i = 0; i < armorSegments.length; i++) {
    const seg = armorSegments[i];
    const on = i < armorOn;
    if (on !== seg.classList.contains('on')) seg.classList.toggle('on', on);
  }
  if (d.armorVal) d.armorVal.textContent = String(Math.round(armorHP));

  // ── Rank / name (cheap — only update on profile change) ───────────
  const profile = getProfile();
  if (d.hvRank) {
    const rank = `LVL ${String(profile.level).padStart(2, '0')}`;
    if (d.hvRank.textContent !== rank) d.hvRank.textContent = rank;
  }
  if (d.hvName) {
    const name = profile.playerName.toUpperCase();
    if (d.hvName.textContent !== name) d.hvName.textContent = name;
  }

  // ── Weapon / ammo card ─────────────────────────────────────────────
  const wep       = WEAPONS[gameState.pWeaponId];
  const isUnarmed = gameState.pWeaponId === 'unarmed';
  const isKnife   = gameState.pWeaponId === 'knife';
  const magSize   = wep?.magSize ?? 1;

  if (d.haWepName) d.haWepName.textContent = wep?.name.toUpperCase() ?? '—';
  if (d.haWepMode) d.haWepMode.textContent = getWeaponModeLabel(gameState.pWeaponId);

  if (isUnarmed || isKnife) {
    if (d.haMag)     d.haMag.textContent     = '—';
    if (d.haReserve) d.haReserve.textContent = '—';
    if (d.haMagDots) d.haMagDots.innerHTML   = '';
    magDotEls.length = 0; lastMagSize = 0;
  } else {
    if (d.haMag) {
      d.haMag.textContent = String(gameState.pAmmo);
      const low = magSize > 0 && gameState.pAmmo > 0 && gameState.pAmmo / magSize < 0.2;
      d.haMag.classList.toggle('low', low);
    }
    if (d.haReserve) d.haReserve.textContent = String(gameState.pAmmoReserve ?? 0);

    rebuildMagDots(magSize);
    const dotsMax = magDotEls.length;
    const scale   = dotsMax / magSize;
    const dotsOn  = Math.round(gameState.pAmmo * scale);
    for (let i = 0; i < dotsMax; i++) {
      const empty = i >= dotsOn;
      if (empty !== magDotEls[i].classList.contains('empty')) {
        magDotEls[i].classList.toggle('empty', empty);
      }
    }
  }

  // Reload hint
  if (d.haReloadHint) {
    const needsReload =
      !isUnarmed && !isKnife && !gameState.pReloading &&
      gameState.pAmmo < magSize;
    d.haReloadHint.classList.toggle('on', needsReload);
  }

  // ── Weapon dock slots (.dk-slot / .dk-wep-svg) ─────────────────────
  const activeSlot = gameState.pActiveSlot ?? 0;
  for (let i = 0; i < 3; i++) {
    const slot = d.dkSlots[i];
    const svg  = d.dkSvgs[i];
    if (!slot || !svg) continue;

    const wepId = gameState.pWeaponSlots?.[i] ?? null;
    const hasWep = !!wepId;

    if (hasWep !== !slot.classList.contains('empty')) {
      slot.classList.toggle('empty', !hasWep);
    }
    const shouldBeActive = hasWep && i === activeSlot;
    if (shouldBeActive !== slot.classList.contains('active')) {
      slot.classList.toggle('active', shouldBeActive);
    }

    if (wepId !== lastSlotWep[i]) {
      svg.innerHTML = hasWep ? getWeaponIconSVG(wepId!) : '';
      lastSlotWep[i] = wepId;
    }
  }
  lastKnownActiveSlot = activeSlot;
}

// ── CROSSHAIR ───────────────────────────────────────────────────────────
export function updateCrosshair(): void {
  const d = cacheDOM();
  const el = d.xh;
  if (!el) return;
  const { keys, pWeaponId } = gameState;
  const isMoving  = !!(keys?.w || keys?.a || keys?.s || keys?.d);
  const isRunning = isMoving && !!keys?.shift;
  const airborne  = (gameState.pPosY ?? 0) > 0.05;

  const baseGap = ({
    unarmed: 10, knife: 10, pistol: 12, smg: 14, assault_rifle: 13,
    shotgun: 18, sniper_rifle: 16, rocket_launcher: 15,
  } as const)[pWeaponId as keyof any] ?? 12;
  const lineLen = ({
    unarmed: 7, knife: 7, pistol: 8, smg: 9, assault_rifle: 10,
    shotgun: 11, sniper_rifle: 12, rocket_launcher: 11,
  } as const)[pWeaponId as keyof any] ?? 8;

  const moveKick = isRunning ? 10 : isMoving ? 5 : 0;
  const airKick  = airborne ? 7 : 0;
  const fireKick = Math.min(10, (gameState.pShootTimer ?? 0) * 55);
  const adsMul   = gameState.isADS ? (pWeaponId === 'sniper_rifle' ? 0.2 : 0.55) : 1;
  const gap = (baseGap + moveKick + airKick + fireKick) * adsMul;

  el.style.setProperty('--xh-gap', `${gap.toFixed(1)}px`);
  el.style.setProperty('--xh-len', `${lineLen}px`);

  const hideCrosshair = !!gameState.isADS && pWeaponId === 'sniper_rifle';
  el.classList.toggle('hidden', hideCrosshair);
  if (d.scope) d.scope.classList.toggle('on', hideCrosshair);

  const dot = el.querySelector('.xh-dot') as HTMLElement | null;
  if (dot) dot.style.opacity = (gameState.isADS && pWeaponId !== 'shotgun') ? '0.25' : '1';
}

let fireTO: ReturnType<typeof setTimeout> | null = null;
export function flashCrosshairFire(): void {
  const d = cacheDOM();
  if (!d.xh) return;
  d.xh.classList.add('fire');
  if (fireTO) clearTimeout(fireTO);
  fireTO = setTimeout(() => d.xh?.classList.remove('fire'), 80);
}

// ── Hit / Kill markers ──────────────────────────────────────────────────
let hitTO: ReturnType<typeof setTimeout> | null = null;
let killTO: ReturnType<typeof setTimeout> | null = null;
export function flashHitMarker(): void {
  const el = document.getElementById('xhHit');
  if (!el) return;
  el.classList.remove('on');
  void el.offsetWidth; // restart animation
  el.classList.add('on');
  if (hitTO) clearTimeout(hitTO);
  hitTO = setTimeout(() => el.classList.remove('on'), 350);
}
export function flashKillMarker(): void {
  const el = document.getElementById('xhKill');
  if (!el) return;
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
  if (killTO) clearTimeout(killTO);
  killTO = setTimeout(() => el.classList.remove('on'), 500);
}

// ── Damage / heal overlays ──────────────────────────────────────────────
let dmgTO: ReturnType<typeof setTimeout> | null = null;
let hlfTO: ReturnType<typeof setTimeout> | null = null;
export function flashDmg(dmg = 20): void {
  const d = cacheDOM();
  if (!d.dmg) return;
  const intensity = 0.3 + Math.min(0.7, dmg / 40);
  d.dmg.style.opacity = String(intensity);
  if (dmgTO) clearTimeout(dmgTO);
  dmgTO = setTimeout(() => { if (d.dmg) d.dmg.style.opacity = '0'; }, 120 + dmg * 2);
}
export function flashHeal(): void {
  const d = cacheDOM();
  if (!d.hlf) return;
  d.hlf.style.opacity = '1';
  if (hlfTO) clearTimeout(hlfTO);
  hlfTO = setTimeout(() => { if (d.hlf) d.hlf.style.opacity = '0'; }, 300);
}

// ── Grenade cook timer ──────────────────────────────────────────────────
let cookEl: HTMLDivElement | null = null;
function ensureCookEl(): HTMLDivElement {
  if (!cookEl) {
    cookEl = document.createElement('div');
    cookEl.id = 'cookTimer';
    document.body.appendChild(cookEl);
  }
  return cookEl;
}
export function updateCookTimer(): void {
  const el = ensureCookEl();
  if (!gameState.pCookingGrenade) {
    el.classList.remove('on', 'danger');
    return;
  }
  const t = gameState.pCookTimer ?? 0;
  el.classList.add('on');
  el.textContent = (Math.max(0, 2.5 - t)).toFixed(1) + 's';
  el.classList.toggle('danger', (t / 2.5) > 0.8);
}

// ── MATCH INFO (top-center .hm-*) ──────────────────────────────────────
/**
 * Drive the .hud-match slate.  Called from mode logic or GameLoop.
 *   modeLabel  — "TDM", "DOMINATION", "HARDPOINT", etc.
 *   timeRemSec — seconds left in match (null = hide timer)
 *   blueScore  — friendly team score
 *   redScore   — hostile team score
 */
export function updateMatchInfo(
  modeLabel: string,
  timeRemSec: number | null,
  blueScore: number,
  redScore: number,
): void {
  const d = cacheDOM();
  if (d.hmMode) d.hmMode.textContent = `◆ ${modeLabel.toUpperCase()}`;
  if (d.hmTimer) {
    if (timeRemSec === null) {
      d.hmTimer.textContent = '--:--';
    } else {
      const clamped = Math.max(0, Math.floor(timeRemSec));
      const m = Math.floor(clamped / 60);
      const s = clamped % 60;
      d.hmTimer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      d.hmTimer.classList.toggle('low', clamped < 30 && clamped > 0);
    }
  }
  if (d.hmScoreBlue) {
    d.hmScoreBlue.textContent = String(blueScore);
    d.hmScoreBlue.classList.toggle('ahead', blueScore > redScore);
  }
  if (d.hmScoreRed) {
    d.hmScoreRed.textContent = String(redScore);
    d.hmScoreRed.classList.toggle('ahead', redScore > blueScore);
  }
}

// ── KILL FEED (.hud-killfeed > .kf-row) ────────────────────────────────
export interface KillFeedEntry {
  killer: string;
  victim: string;
  killerTeam: 'blue' | 'red' | 'neutral';
  victimTeam: 'blue' | 'red' | 'neutral';
  weapon: WeaponId | string;
  isHeadshot: boolean;
  youAreKiller?: boolean;
  youAreVictim?: boolean;
}

const KF_MAX_ROWS = 5;
const KF_LIFETIME_MS = 6000;

/**
 * Push a kill into the feed.  Creates a .kf-row in the preview shape.
 * The player-as-killer row gets the `.me` class so the CSS accent bar
 * turns amber instead of grey.
 */
export function pushKillFeed(e: KillFeedEntry): void {
  const d = cacheDOM();
  if (!d.killfeed) return;

  const row = document.createElement('div');
  const classes = ['kf-row'];
  if (e.youAreKiller) classes.push('me');
  row.className = classes.join(' ');

  const weaponSvg = (() => {
    try { return getWeaponIconSVG(e.weapon as WeaponId); }
    catch { return GLYPHS.weapon_default; }
  })();

  const killerCls = e.killerTeam === 'blue' ? 'friendly' : e.killerTeam === 'red' ? 'hostile' : '';
  const victimCls = e.victimTeam === 'blue' ? 'friendly' : e.victimTeam === 'red' ? 'hostile' : '';

  row.innerHTML = `
    <span class="kf-killer ${killerCls}">${escapeHTML(e.killer)}</span>
    <span class="kf-wep">${weaponSvg}</span>
    ${e.isHeadshot ? '<span class="kf-hs">◆</span>' : ''}
    <span class="kf-victim ${victimCls}">${escapeHTML(e.victim)}</span>
  `;

  d.killfeed.appendChild(row);

  // Cap rows
  while (d.killfeed.children.length > KF_MAX_ROWS) {
    d.killfeed.removeChild(d.killfeed.firstChild!);
  }

  // Auto-expire
  setTimeout(() => {
    row.style.transition = 'opacity .3s, transform .3s';
    row.style.opacity = '0';
    row.style.transform = 'translateX(20px)';
    setTimeout(() => row.remove(), 320);
  }, KF_LIFETIME_MS);
}

export function clearKillFeed(): void {
  const d = cacheDOM();
  if (d.killfeed) d.killfeed.innerHTML = '';
}

function escapeHTML(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}
