import { TEAM_BLUE } from '@/config/constants';
import { gameState, type KillfeedEntry } from '@/core/GameState';
import { dom } from './DOMElements';
import { getWeaponIconSVG } from './WeaponIcons';
import type { WeaponId } from '@/config/weapons';

/**
 * Add a new kill feed entry and re-render.
 */
export function addKillfeedEntry(
  killer: string,
  victim: string,
  killerTeam: number,
  victimTeam: number,
  weaponName?: string,
  headshot?: boolean,
  weaponId?: WeaponId,
  isAssist?: boolean,
  isWallbang?: boolean,
): void {
  const entry: KillfeedEntry = {
    killer, victim, killerTeam, victimTeam,
    time: gameState.worldElapsed,
    weaponName,
    weaponId,
    headshot,
    isAssist,
    isWallbang,
  };
  gameState.killfeedEntries.push(entry);
  if (gameState.killfeedEntries.length > 6) gameState.killfeedEntries.shift();
  renderKillfeed();
}

/**
 * Render the kill feed from current entries.
 */
function renderKillfeed(): void {
  dom.killfeed.innerHTML = gameState.killfeedEntries
    .slice()
    .reverse()
    .map((e) => {
      const killerCls = e.killerTeam === TEAM_BLUE ? 'friendly' : 'hostile';
      const victimCls = e.victimTeam === TEAM_BLUE ? 'friendly' : 'hostile';
      const icon = e.weaponId ? getWeaponIconSVG(e.weaponId as WeaponId) : '';
      const wep = icon
        ? `<span class="kf-wep">${icon}</span>`
        : e.weaponName
          ? `<span class="kf-wep">${escapeHTML(e.weaponName.toUpperCase())}</span>`
          : '<span class="kf-wep">►</span>';
      const hs = e.headshot ? '<span class="kf-tag kf-tag-headshot" title="Headshot">◆</span>' : '';
      const assistTag = e.isAssist ? '<span class="kf-tag kf-tag-assist" title="Assist">A</span>' : '';
      const pName = gameState.player.name;
      const selfCls = e.killer === pName ? ' me' : '';
      return `<div class="kf-row${selfCls}">${assistTag}<span class="kf-killer ${killerCls}">${escapeHTML(e.killer)}</span>${wep}${hs}<span class="kf-victim ${victimCls}">${escapeHTML(e.victim)}</span></div>`;
    })
    .join('');
}

function escapeHTML(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}
