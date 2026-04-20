import { gameState } from '@/core/GameState';
import { WEAPONS, type WeaponId } from '@/config/weapons';
import { dom } from './DOMElements';
import { getWeaponIconSVG, getWeaponModeLabel } from './WeaponIcons';
import { getPlayerInventory } from '@/br/InventoryUI';
import { GLYPHS } from './Glyphs';

/**
 * HUD — the in-match tick.  Runs every frame (throttled internally)
 * and pushes text / classes into the pre-rendered DOM in index.html.
 *
 * APEX PROTOCOL changes vs. legacy:
 *   - HP & armor icons use Glyphs.ts SVGs (spec Phase 2 step 4).
 *     The unicode ❤ and 🛡 in index.html are replaced on first paint.
 *   - `.low` class toggles on .bh-hp-bar (hp<35), .bh-wc-ammo (ammo<20%),
 *     and .mi-time (timer<30s) to drive the intensity-scaling pulses
 *     defined in index.css.
 *   - Slot icons use getWeaponIconSVG from WeaponIcons.ts.
 */

let dmgTO:  ReturnType<typeof setTimeout>;
let hlfTO:  ReturnType<typeof setTimeout>;
let fireTO: ReturnType<typeof setTimeout>;

const xhEl = (): HTMLElement => document.getElementById('xh')!;

// Cache last-rendered values to avoid pointless DOM writes.
const lastSlotIcons: (WeaponId | null)[] = [null, null, null];
let glyphsInjected = false;

/**
 * One-shot on the first update: replace the static emoji in the HP /
 * armor icon divs with crisp SVG glyphs from the registry.  Before
 * this runs, index.html is showing unicode ❤ and 🛡.
 */
function injectHudGlyphsOnce(): void {
  if (glyphsInjected) return;

  const iconEls = document.querySelectorAll<HTMLElement>('.bh-hp-icon');
  iconEls.forEach(el => { el.innerHTML = GLYPHS.heart; });

  const armorEls = document.querySelectorAll<HTMLElement>('.bh-armor-icon');
  armorEls.forEach(el => { el.innerHTML = GLYPHS.shield; });

  const gadgetEls = document.querySelectorAll<HTMLElement>('.bh-gadget-icon');
  gadgetEls.forEach(el => { el.innerHTML = GLYPHS.grenade; });

  glyphsInjected = true;
}

export function updateHUD(): void {
  injectHudGlyphsOnce();

  // ── Health ──
  const hpPct = Math.max(0, Math.min(100, gameState.pHP));
  dom.hpFill.style.width = hpPct + '%';
  dom.hpTxt.textContent = String(Math.round(hpPct));

  // Low-HP pulse class on the whole HP bar (CSS drives the pulse).
  dom.hpFill.parentElement?.classList.toggle('low', hpPct < 35);

  // ── Armor ──
  if (gameState.mode === 'br') {
    const inv = getPlayerInventory();
    const armorPct = inv && inv.maxArmorHP > 0
      ? Math.max(0, Math.min(100, (inv.armorHP / inv.maxArmorHP) * 100))
      : 0;
    if (dom.armorFill) dom.armorFill.style.width = armorPct + '%';
    if (dom.armorTxt)  dom.armorTxt.textContent = String(Math.round(inv?.armorHP ?? 0));
  } else {
    if (dom.armorFill) dom.armorFill.style.width = '0%';
    if (dom.armorTxt)  dom.armorTxt.textContent = '0';
  }

  // ── Weapon card ──
  const wep       = WEAPONS[gameState.pWeaponId];
  const isUnarmed = gameState.pWeaponId === 'unarmed';
  const isKnife   = gameState.pWeaponId === 'knife';

  dom.weaponName.textContent = wep.name;

  if (isUnarmed || isKnife) {
    dom.ammoTxt.textContent = '—';
    dom.ammoMax.textContent = '';
  } else {
    dom.ammoTxt.textContent = String(gameState.pAmmo);
    dom.ammoMax.textContent = `/ ${wep.magSize}  [${gameState.pAmmoReserve}]`;
  }

  // Low-ammo pulse (intensity scaling §4)
  const lowAmmo = !isUnarmed && !isKnife
    && gameState.pAmmo > 0
    && gameState.pAmmo / wep.magSize < 0.2;
  dom.ammoTxt.classList.toggle('low', lowAmmo);

  // Weapon glyph + mode — only write to DOM when the weapon changes.
  if (dom.wcIcon && (dom.wcIcon as any)._lastWid !== gameState.pWeaponId) {
    dom.wcIcon.innerHTML = getWeaponIconSVG(gameState.pWeaponId);
    (dom.wcIcon as any)._lastWid = gameState.pWeaponId;
  }
  if (dom.wcMode) dom.wcMode.textContent = getWeaponModeLabel(gameState.pWeaponId);

  // Reload hint: visible when pistol/rifle/etc is partially empty
  if (dom.wcReloadHint) {
    const needsReload =
      !isUnarmed && !isKnife &&
      gameState.pAmmo < wep.magSize &&
      !gameState.pReloading;
    dom.wcReloadHint.classList.toggle('on', needsReload);
    dom.wcReloadHint.textContent = 'R';
  }

  // ── Weapon slots ──
  for (let i = 0; i < 3; i++) {
    const slotEl = [dom.slot0,     dom.slot1,     dom.slot2][i];
    const iconEl = [dom.slot0icon, dom.slot1icon, dom.slot2icon][i];
    const nameEl = [dom.slot0name, dom.slot1name, dom.slot2name][i];
    if (!slotEl || !iconEl || !nameEl) continue;

    const wepId = gameState.pWeaponSlots[i];
    if (wepId) {
      slotEl.classList.toggle('active', gameState.pActiveSlot === i);
      slotEl.classList.remove('empty');
      if (lastSlotIcons[i] !== wepId) {
        iconEl.innerHTML = getWeaponIconSVG(wepId);
        nameEl.textContent = WEAPONS[wepId].name;
        lastSlotIcons[i] = wepId;
      }
    } else {
      slotEl.classList.add('empty');
      slotEl.classList.remove('active');
      if (lastSlotIcons[i] !== null) {
        iconEl.innerHTML = '—';
        nameEl.textContent = '—';
        lastSlotIcons[i] = null;
      }
    }
  }

  // ── Grenades ──
  dom.grenadeTxt.textContent = String(gameState.pGrenades);
}

export function updateCrosshair(): void {
  const el = xhEl();
  if (!el) return;
  const { keys, pWeaponId } = gameState;
  const isMoving  = keys.w || keys.a || keys.s || keys.d;
  const isRunning = isMoving && keys.shift;
  const airborne  = gameState.pPosY > 0.05;
  const wep = WEAPONS[pWeaponId];

  // Weapon-specific baseline gap + blade length
  const baseGap = ({
    unarmed: 10, knife: 10, pistol: 12, smg: 14, assault_rifle: 13,
    shotgun: 18, sniper_rifle: 16, rocket_launcher: 15,
  } as const)[pWeaponId] ?? 12;

  const lineLen = ({
    unarmed: 7, knife: 7, pistol: 8, smg: 9, assault_rifle: 10,
    shotgun: 11, sniper_rifle: 12, rocket_launcher: 11,
  } as const)[pWeaponId] ?? 8;

  const moveKick = isRunning ? 10 : isMoving ? 5 : 0;
  const airKick  = airborne ? 7 : 0;
  const fireKick = Math.min(10, gameState.pShootTimer * 55);
  const adsBloom = gameState.adsAmount !== undefined
    ? Math.sin(Math.min(1, Math.abs(gameState.adsAmount - (gameState.isADS ? 1 : 0)) * 4) * Math.PI) * 6
    : 0;
  const adsMul = gameState.isADS ? (pWeaponId === 'sniper_rifle' ? 0.2 : 0.55) : 1;

  const gap = (baseGap + moveKick + airKick + fireKick + adsBloom) * adsMul;

  el.style.setProperty('--xh-gap', `${gap.toFixed(1)}px`);
  el.style.setProperty('--xh-len', `${lineLen}px`);
  el.dataset.weapon = pWeaponId;
  el.classList.toggle('spread', gap > baseGap + 1);

  // Hide the crosshair while aiming through a sniper scope.
  const hideCrosshair = gameState.isADS && pWeaponId === 'sniper_rifle';
  el.classList.toggle('hidden', hideCrosshair);

  const scope = document.getElementById('scopeOverlay');
  if (scope) scope.classList.toggle('on', hideCrosshair);

  const dot = el.querySelector('.xh-dot') as HTMLElement | null;
  if (dot) dot.style.opacity = gameState.isADS && pWeaponId !== 'shotgun' ? '0.25' : '1';
}

export function flashCrosshairFire(): void {
  const el = xhEl();
  if (!el) return;
  el.classList.add('fire', 'spread');
  clearTimeout(fireTO);
  fireTO = setTimeout(() => el.classList.remove('fire'), 80);
}

export function flashDmg(dmg: number = 20): void {
  const intensity = 0.3 + Math.min(0.7, dmg / 40);
  dom.dmg.style.opacity = String(intensity);
  clearTimeout(dmgTO);
  dmgTO = setTimeout(() => { dom.dmg.style.opacity = '0'; }, 120 + dmg * 2);
}

export function flashHeal(): void {
  dom.hlf.style.opacity = '1';
  clearTimeout(hlfTO);
  hlfTO = setTimeout(() => { dom.hlf.style.opacity = '0'; }, 300);
}

// ── Grenade cook timer HUD ──
let cookEl: HTMLDivElement | null = null;
function ensureCookEl(): HTMLDivElement {
  if (!cookEl) {
    cookEl = document.createElement('div');
    cookEl.id = 'cookTimer';
    document.getElementById('cw')?.appendChild(cookEl);
  }
  return cookEl;
}

export function updateCookTimer(): void {
  const el = ensureCookEl();
  if (!gameState.pCookingGrenade) {
    el.classList.remove('on', 'danger');
    return;
  }
  const pct = Math.min(1, gameState.pCookTimer / 2.5);
  el.classList.add('on');
  el.textContent = (2.5 - gameState.pCookTimer).toFixed(1) + 's';
  if (pct > 0.8) el.classList.add('danger');
  else           el.classList.remove('danger');
}
