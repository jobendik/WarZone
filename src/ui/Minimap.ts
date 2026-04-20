import { gameState } from '@/core/GameState';
import { ARENA_HALF, TEAM_BLUE } from '@/config/constants';
import { dom } from './DOMElements';
import { canSee } from '@/ai/Perception';
import { zone as brZone } from '@/br/ZoneSystem';
import { isUAVActive } from '@/combat/Streaks';
import { getDomState } from '@/combat/Domination';
import { getHardpointState } from '@/combat/Hardpoint';
import { getKothState } from '@/combat/KingOfTheHill';
import { getSdState } from '@/combat/Searchanddestroy';

let _spotFrame = 0;
const _spottedCache = new Set<string>();
let _lastObjectivesMarkup = '';

function updateObjectiveRail(): void {
  const rail = dom.mmObjectives;
  if (!rail) return;

  let markup = '';

  if (gameState.mode === 'domination') {
    const state = getDomState();
    if (state) {
      markup = state.zones.map((zone) => {
        const cls = zone.contested ? 'neutral' : zone.owner === 'red' ? 'hostile' : zone.owner === 'blue' ? '' : 'neutral';
        const status = zone.contested ? 'CT' : zone.owner === 'blue' ? 'B' : zone.owner === 'red' ? 'R' : 'N';
        return `<div class="mm-obj ${cls}">${zone.id} ${status}</div>`;
      }).join('');
    }
  } else if (gameState.mode === 'hardpoint') {
    const state = getHardpointState();
    if (state) {
      const active = state.positions[state.activeIndex];
      const ownerClass = state.contested ? 'neutral' : state.holder === 'red' ? 'hostile' : state.holder === 'blue' ? '' : 'neutral';
      const remaining = Math.max(0, Math.ceil(state.rotateInterval - state.timeOnPoint));
      markup = [
        '<div class="mm-obj neutral">HILL</div>',
        `<div class="mm-obj ${ownerClass}">${active.name}</div>`,
        `<div class="mm-obj neutral">${remaining}s</div>`,
      ].join('');
    }
  } else if (gameState.mode === 'koth') {
    const state = getKothState();
    if (state) {
      const statusClass = state.contested ? 'neutral' : state.holder === 'red' ? 'hostile' : state.holder === 'blue' ? '' : 'neutral';
      const progress = `${Math.floor(state.holdBlue)}-${Math.floor(state.holdRed)}`;
      const status = state.contested ? 'CONTEST' : state.holder === 'blue' ? 'BLUE HOLD' : state.holder === 'red' ? 'RED HOLD' : 'NEUTRAL';
      markup = [
        '<div class="mm-obj neutral">HILL</div>',
        `<div class="mm-obj ${statusClass}">${status}</div>`,
        `<div class="mm-obj neutral">${progress}</div>`,
      ].join('');
    }
  } else if (gameState.mode === 'sd') {
    const state = getSdState();
    if (state) {
      const statusClass = state.roundPhase === 'planted' ? 'hostile' : 'neutral';
      const status = state.roundPhase === 'planted'
        ? 'BOMB LIVE'
        : state.roundPhase === 'prep'
          ? 'PREP'
          : state.attackerTeam === 'blue'
            ? 'BLUE ATK'
            : 'RED ATK';
      markup = [
        `<div class="mm-obj neutral">R${state.round}</div>`,
        `<div class="mm-obj ${statusClass}">${status}</div>`,
        '<div class="mm-obj neutral">SITE A</div>',
      ].join('');
    }
  }

  if (markup !== _lastObjectivesMarkup) {
    rail.innerHTML = markup;
    rail.style.display = markup ? 'flex' : 'none';
    _lastObjectivesMarkup = markup;
  }
}

export function drawMinimap(): void {
  const canvas = dom.mmCanvas;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const { arenaColliders, agents, player, cameraYaw, pickups } = gameState;

  // Clear
  ctx.fillStyle = 'rgba(10, 16, 28, 0.92)';
  ctx.fillRect(0, 0, w, h);

  // Grid backdrop
  ctx.strokeStyle = 'rgba(74, 168, 255, 0.08)';
  ctx.lineWidth = 1;
  const gridStep = w / 12;
  for (let i = 0; i <= 12; i++) {
    ctx.beginPath();
    ctx.moveTo(i * gridStep, 0);
    ctx.lineTo(i * gridStep, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * gridStep);
    ctx.lineTo(w, i * gridStep);
    ctx.stroke();
  }

  const worldHalf = gameState.mode === 'br' ? 210 : ARENA_HALF + 5;
  const scale = w / (worldHalf * 2);
  const cx = w / 2;
  const cy = h / 2;
  const toX = (x: number) => cx + x * scale;
  const toY = (z: number) => cy + z * scale;

  // Walls (muted)
  ctx.fillStyle = 'rgba(70, 120, 180, 0.32)';
  ctx.strokeStyle = 'rgba(90, 150, 220, 0.5)';
  ctx.lineWidth = 1;
  for (const c of arenaColliders) {
    if (c.type === 'box') {
      const x = toX(c.x - c.hw);
      const y = toY(c.z - c.hd);
      const bw = c.hw * 2 * scale;
      const bh = c.hd * 2 * scale;
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeRect(x, y, bw, bh);
    } else {
      ctx.beginPath();
      ctx.arc(toX(c.x), toY(c.z), c.r * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Pickups
  for (const p of pickups) {
    if (!p.active) continue;
    ctx.save();
    let col = '#22d66a';
    if (p.t === 'ammo') col = '#ffaa33';
    else if (p.t === 'weapon') col = '#a47aff';
    else if (p.t === 'grenade') col = '#84cc16';
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(toX(p.x), toY(p.z), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Agents
  _spotFrame++;
  for (const ag of agents) {
    if (ag.isDead) continue;
    const x = toX(ag.position.x);
    const y = toY(ag.position.z);

    if (ag === player) {
      // Player — FOV cone + triangle
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-cameraYaw);

      // FOV cone
      ctx.fillStyle = 'rgba(74, 168, 255, 0.18)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      const fovLen = 30;
      const fovHalf = 0.6;
      ctx.lineTo(Math.sin(-fovHalf) * fovLen, -Math.cos(-fovHalf) * fovLen);
      ctx.arc(0, 0, fovLen, -Math.PI / 2 - fovHalf, -Math.PI / 2 + fovHalf);
      ctx.closePath();
      ctx.fill();

      // Triangle
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#4aa8ff';
      ctx.fillStyle = '#6ac0ff';
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(-4, 5);
      ctx.lineTo(0, 3);
      ctx.lineTo(4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      const isAlly = ag.team === TEAM_BLUE;
      if (!isAlly) {
        // Only show spotted enemies (or all if UAV active)
        if (!isUAVActive()) {
          if (_spotFrame % 6 === 0) {
            _spottedCache.clear();
            for (const e of agents) {
              if (e.team === TEAM_BLUE || e.isDead) continue;
              if (agents.some(a => a.team === TEAM_BLUE && !a.isDead && canSee(a, e))) _spottedCache.add(e.name);
            }
          }
          if (!_spottedCache.has(ag.name)) continue;
        }
      }
      const col = isAlly ? '#4aa8ff' : '#ff5c5c';
      const inCombat = ag.stateName === 'ENGAGE' || ag.stateName === 'TEAM_PUSH';
      const pulse = inCombat ? 1 + Math.sin(gameState.worldElapsed * 10) * 0.3 : 1;

      ctx.save();
      ctx.shadowBlur = 6;
      ctx.shadowColor = col;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, 3 * pulse, 0, Math.PI * 2);
      ctx.fill();

      // Facing indicator for allies
      if (isAlly) {
        const qY = ag.rotation.y ?? 0;
        const qW = ag.rotation.w ?? 1;
        const yaw = 2 * Math.atan2(qY, qW);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.sin(yaw) * 7, y + Math.cos(yaw) * 7);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
  }

  // BR zone circles
  if (gameState.mode === 'br' && brZone.active) {
    // Current zone – blue
    ctx.save();
    ctx.strokeStyle = 'rgba(74, 168, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(toX(brZone.currentCenter.x), toY(brZone.currentCenter.y), brZone.currentRadius * scale, 0, Math.PI * 2);
    ctx.stroke();
    // Target zone – white dashed
    if (brZone.isShrinking) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(toX(brZone.targetCenter.x), toY(brZone.targetCenter.y), brZone.targetRadius * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Damage direction arrow ──
  const dmgAge = gameState.worldElapsed - (gameState.pLastDamageTime ?? -999);
  if (dmgAge < 2 && (gameState as any).pLastAttackerX != null) {
    const ax = (gameState as any).pLastAttackerX as number;
    const az = (gameState as any).pLastAttackerZ as number;
    const dx = ax - player.position.x;
    const dz = az - player.position.z;
    const angle = Math.atan2(dx, dz);
    const arrowDist = Math.min(w * 0.42, Math.hypot(dx, dz) * scale);
    const arrowX = cx + Math.sin(angle) * arrowDist;
    const arrowY = cy + Math.cos(angle) * arrowDist;
    const alpha = Math.max(0, 1 - dmgAge / 2);

    ctx.save();
    ctx.translate(arrowX, arrowY);
    ctx.rotate(-angle);
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = '#ff4444';
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(-4, 4);
    ctx.lineTo(0, 2);
    ctx.lineTo(4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Coords readout
  if (dom.mmCoords) {
    const px = Math.round(player.position.x);
    const pz = Math.round(player.position.z);
    dom.mmCoords.textContent = `${px >= 0 ? '+' : ''}${px}, ${pz >= 0 ? '+' : ''}${pz}`;
  }

  updateObjectiveRail();
}
