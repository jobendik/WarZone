/**
 * Emotes — gesture wheel for player expression.
 *
 * Hold B to open a wheel; select one of 4 equipped emotes.
 * Emotes play on the player's third-person model (visible to others via
 * network in a multiplayer context, but here just a local visual effect).
 *
 * Sprays: 3 equipped sprays. Hold T and aim at a wall → spray decal sticks
 * for 30 seconds.
 *
 * Design:
 *   - 12 total emotes (4 equip slots from player profile)
 *   - Emote types: animation (uses existing anim clips), visual_effect
 *     (particle burst), voice_line (TTS)
 *   - Sprays as SVG decals projected onto walls via raycast
 *   - Hooks into PlayerProfile.equipped.activeEmotes / .sprays
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { getProfile } from '@/core/PlayerProfile';
import { Audio } from '@/audio/AudioManager';

// ─────────────────────────────────────────────────────────────────────
//  EMOTE CATALOG
// ─────────────────────────────────────────────────────────────────────

export type EmoteKind = 'animation' | 'voice' | 'effect';

export interface EmoteDef {
  id: string;
  name: string;
  kind: EmoteKind;
  /** For animation emotes: animation clip name. */
  clip?: string;
  /** For voice emotes: the line spoken (plain text). */
  voiceLine?: string;
  /** For effect emotes: particle color / type. */
  effect?: 'confetti' | 'skull' | 'heart' | 'fire' | 'sparkle';
  duration: number;       // seconds
  cooldown: number;       // seconds
  icon: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

export const EMOTES: Record<string, EmoteDef> = {
  wave:       { id: 'wave',       name: 'Wave',         kind: 'animation', clip: 'Waving',      duration: 2,   cooldown: 2,  icon: '👋', rarity: 'common' },
  salute:     { id: 'salute',     name: 'Salute',       kind: 'animation', clip: 'Salute',      duration: 2.2, cooldown: 2,  icon: '🫡', rarity: 'common' },
  taunt:      { id: 'taunt',      name: 'Taunt',        kind: 'voice',     voiceLine: 'Is that all you got?', duration: 2, cooldown: 4, icon: '😤', rarity: 'common' },
  laugh:      { id: 'laugh',      name: 'Laugh',        kind: 'voice',     voiceLine: 'Ha ha ha!', duration: 2, cooldown: 3, icon: '😂', rarity: 'common' },
  dance:      { id: 'dance',      name: 'Dance',        kind: 'animation', clip: 'Dancing',     duration: 4,   cooldown: 6,  icon: '💃', rarity: 'rare' },
  flex:       { id: 'flex',       name: 'Flex',         kind: 'animation', clip: 'Flexing',     duration: 2.5, cooldown: 4,  icon: '💪', rarity: 'rare' },
  facepalm:   { id: 'facepalm',   name: 'Facepalm',     kind: 'animation', clip: 'FacePalm',    duration: 2,   cooldown: 3,  icon: '🤦', rarity: 'common' },
  clap:       { id: 'clap',       name: 'Slow Clap',    kind: 'animation', clip: 'Clapping',    duration: 3,   cooldown: 3,  icon: '👏', rarity: 'common' },
  kneel:      { id: 'kneel',      name: 'Kneel',        kind: 'animation', clip: 'Kneeling',    duration: 2.5, cooldown: 4,  icon: '🙇', rarity: 'rare' },
  dab:        { id: 'dab',        name: 'Dab',          kind: 'animation', clip: 'Dab',         duration: 1.5, cooldown: 3,  icon: '🤳', rarity: 'epic' },
  vinyl_drop: { id: 'vinyl_drop', name: 'Vinyl Drop',   kind: 'effect',    effect: 'sparkle',   duration: 3,   cooldown: 10, icon: '💿', rarity: 'epic' },
  skull:      { id: 'skull',      name: 'Memento Mori', kind: 'effect',    effect: 'skull',     duration: 3,   cooldown: 10, icon: '💀', rarity: 'legendary' },
};

// ─────────────────────────────────────────────────────────────────────
//  SPRAY CATALOG
// ─────────────────────────────────────────────────────────────────────

export interface SprayDef {
  id: string;
  name: string;
  svgInner: string;      // inner SVG markup (viewBox 0 0 200 200)
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

export const SPRAYS: Record<string, SprayDef> = {
  smiley:   { id: 'smiley', name: 'Smiley', rarity: 'common',
    svgInner: `<circle cx="100" cy="100" r="90" fill="#ffcc00" stroke="#000" stroke-width="4"/>
               <circle cx="70" cy="80" r="10" fill="#000"/>
               <circle cx="130" cy="80" r="10" fill="#000"/>
               <path d="M 55 125 Q 100 165 145 125" stroke="#000" stroke-width="5" fill="none"/>` },
  skull_spr:{ id: 'skull_spr', name: 'Skull', rarity: 'common',
    svgInner: `<circle cx="100" cy="90" r="70" fill="#f0f0f0" stroke="#222" stroke-width="3"/>
               <rect x="75" y="155" width="50" height="25" fill="#f0f0f0" stroke="#222" stroke-width="3"/>
               <circle cx="78" cy="92" r="12" fill="#222"/>
               <circle cx="122" cy="92" r="12" fill="#222"/>
               <path d="M 90 125 L 110 125 L 105 145 L 100 135 L 95 145 Z" fill="#222"/>` },
  checkmark:{ id: 'checkmark', name: 'GG', rarity: 'common',
    svgInner: `<circle cx="100" cy="100" r="90" fill="#22d66a" stroke="#fff" stroke-width="4"/>
               <path d="M 50 100 L 90 140 L 150 70" stroke="#fff" stroke-width="12" fill="none" stroke-linecap="round"/>` },
  warning:  { id: 'warning', name: 'Danger', rarity: 'rare',
    svgInner: `<path d="M 100 10 L 190 170 L 10 170 Z" fill="#ffcc00" stroke="#000" stroke-width="4"/>
               <rect x="95" y="60" width="10" height="60" fill="#000"/>
               <rect x="95" y="130" width="10" height="12" fill="#000"/>` },
  crosshair:{ id: 'crosshair', name: 'Target', rarity: 'epic',
    svgInner: `<circle cx="100" cy="100" r="90" fill="none" stroke="#ff2030" stroke-width="4"/>
               <line x1="10" y1="100" x2="85" y2="100" stroke="#ff2030" stroke-width="4"/>
               <line x1="115" y1="100" x2="190" y2="100" stroke="#ff2030" stroke-width="4"/>
               <line x1="100" y1="10" x2="100" y2="85" stroke="#ff2030" stroke-width="4"/>
               <line x1="100" y1="115" x2="100" y2="190" stroke="#ff2030" stroke-width="4"/>
               <circle cx="100" cy="100" r="3" fill="#ff2030"/>` },
};

// ─────────────────────────────────────────────────────────────────────
//  RUNTIME STATE
// ─────────────────────────────────────────────────────────────────────

interface ActiveEmote {
  id: string;
  startTime: number;
  actor: any;   // player or bot
  mixer?: THREE.AnimationMixer;
  cleanup?: () => void;
}

interface ActiveSpray {
  mesh: THREE.Mesh;
  createdAt: number;
  lifetimeSec: number;
}

interface EmoteState {
  active: ActiveEmote | null;
  lastEmoteTime: Record<string, number>;
  wheelVisible: boolean;
  wheelContainer: HTMLDivElement | null;
  wheelX: number;
  wheelY: number;
  wheelSelection: number | null;
  sprayAimMode: boolean;
  sprays: ActiveSpray[];
  holdStart: number;
}

const state: EmoteState = {
  active: null,
  lastEmoteTime: {},
  wheelVisible: false,
  wheelContainer: null,
  wheelX: 0, wheelY: 0,
  wheelSelection: null,
  sprayAimMode: false,
  sprays: [],
  holdStart: 0,
};

// ─────────────────────────────────────────────────────────────────────
//  EMOTE EXECUTION
// ─────────────────────────────────────────────────────────────────────

export function playEmote(emoteId: string, actor: any = gameState.player): boolean {
  const def = EMOTES[emoteId];
  if (!def) return false;
  if (!actor) return false;

  // Cooldown
  const lastTime = state.lastEmoteTime[emoteId] ?? 0;
  if (performance.now() / 1000 - lastTime < def.cooldown) return false;

  // Don't stack
  if (state.active) return false;

  state.active = {
    id: emoteId,
    startTime: performance.now() / 1000,
    actor,
  };
  state.lastEmoteTime[emoteId] = state.active.startTime;

  // Animation path
  if (def.kind === 'animation' && def.clip) {
    tryPlayAnimation(actor, def.clip, def.duration);
  }

  // Voice path
  if (def.kind === 'voice' && def.voiceLine) {
    try {
      const u = new SpeechSynthesisUtterance(def.voiceLine);
      u.rate = 1; u.volume = 0.7 * Audio.voiceVolume * Audio.masterVolume;
      window.speechSynthesis?.speak(u);
    } catch { /* */ }
  }

  // Effect path
  if (def.kind === 'effect' && def.effect && actor.mesh) {
    spawnEmoteParticles(actor.mesh.position, def.effect, def.duration);
  }

  // Emote badge above actor
  spawnEmoteBadge(actor, def);

  // Clear after duration
  setTimeout(() => {
    if (state.active?.id === emoteId) {
      state.active.cleanup?.();
      state.active = null;
    }
  }, def.duration * 1000);

  return true;
}

function tryPlayAnimation(actor: any, clipName: string, duration: number): void {
  const mixer = actor.mesh?.userData?.animMixer as THREE.AnimationMixer | undefined;
  const clips = actor.mesh?.userData?.animClips as THREE.AnimationClip[] | undefined;
  if (!mixer || !clips) return;

  const clip = THREE.AnimationClip.findByName(clips, clipName);
  if (!clip) return;

  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.fadeIn(0.15);
  action.play();

  setTimeout(() => {
    action.fadeOut(0.2);
  }, (duration - 0.2) * 1000);

  if (state.active) {
    state.active.mixer = mixer;
    state.active.cleanup = () => {
      action.stop();
    };
  }
}

function spawnEmoteParticles(pos: THREE.Vector3, kind: EmoteDef['effect'], duration: number): void {
  const scene = gameState.scene as THREE.Scene | undefined;
  if (!scene) return;
  const sceneRef: THREE.Scene = scene;

  const particleCount = kind === 'skull' ? 20 : 60;
  const colors = {
    confetti: [0xff3344, 0x4a9eff, 0xffcc44, 0x22d66a, 0xaa66ff],
    skull: [0xffffff, 0xcccccc, 0x888888],
    heart: [0xff4466, 0xff7799, 0xffccdd],
    fire: [0xff5500, 0xff9900, 0xffcc00],
    sparkle: [0xffffff, 0xffcc44, 0x88ccff],
  };
  const pool = colors[kind!] ?? colors.confetti;

  const positions = new Float32Array(particleCount * 3);
  const velocities = new Float32Array(particleCount * 3);
  const colorAttr = new Float32Array(particleCount * 3);

  for (let i = 0; i < particleCount; i++) {
    positions[i * 3 + 0] = pos.x + (Math.random() - 0.5) * 0.3;
    positions[i * 3 + 1] = pos.y + 1.5;
    positions[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.3;
    velocities[i * 3 + 0] = (Math.random() - 0.5) * 4;
    velocities[i * 3 + 1] = 2 + Math.random() * 4;
    velocities[i * 3 + 2] = (Math.random() - 0.5) * 4;
    const c = new THREE.Color(pool[Math.floor(Math.random() * pool.length)]);
    colorAttr[i * 3 + 0] = c.r; colorAttr[i * 3 + 1] = c.g; colorAttr[i * 3 + 2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.2, vertexColors: true, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  sceneRef.add(points);

  const start = performance.now() / 1000;
  function animate() {
    const dt = 1 / 60;
    const elapsed = performance.now() / 1000 - start;
    if (elapsed > duration) {
      sceneRef.remove(points);
      geo.dispose();
      mat.dispose();
      return;
    }
    const arr = geo.attributes.position.array as Float32Array;
    for (let i = 0; i < particleCount; i++) {
      const ix = i * 3;
      arr[ix + 0] += velocities[ix + 0] * dt;
      arr[ix + 1] += velocities[ix + 1] * dt;
      arr[ix + 2] += velocities[ix + 2] * dt;
      velocities[ix + 1] -= 8 * dt; // gravity
    }
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    mat.opacity = Math.max(0, 1 - elapsed / duration);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

function spawnEmoteBadge(actor: any, def: EmoteDef): void {
  if (!actor.mesh) return;
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(8,14,24,0.85)';
  ctx.beginPath();
  ctx.arc(64, 64, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffcc44';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = 'white';
  ctx.font = '72px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(def.icon, 64, 72);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.5, 0.5, 1);
  sprite.position.y = 2.4;
  actor.mesh.add(sprite);

  setTimeout(() => {
    actor.mesh.remove(sprite);
    tex.dispose();
    mat.dispose();
  }, def.duration * 1000);
}

// ─────────────────────────────────────────────────────────────────────
//  EMOTE WHEEL
// ─────────────────────────────────────────────────────────────────────

function ensureWheel(): HTMLDivElement {
  if (state.wheelContainer) return state.wheelContainer;
  state.wheelContainer = document.createElement('div');
  state.wheelContainer.id = 'emoteWheel';
  document.body.appendChild(state.wheelContainer);

  if (!document.getElementById('emoteWheelStyle')) {
    const s = document.createElement('style');
    s.id = 'emoteWheelStyle';
    s.textContent = `
      #emoteWheel {
        position: fixed; inset: 0;
        pointer-events: none;
        z-index: 12;
        display: none;
      }
      #emoteWheel.active { display: block; }
      .ew-bg {
        position: absolute; inset: 0;
        background: radial-gradient(circle at center, rgba(0,0,0,0.3), rgba(0,0,0,0.6));
      }
      .ew-title {
        position: absolute; left: 50%; top: calc(50% - 180px);
        transform: translateX(-50%);
        font: bold 13px 'Consolas', monospace;
        letter-spacing: 0.3em;
        color: #ffcc44;
      }
      .ew-slot {
        position: absolute; left: 50%; top: 50%;
        width: 90px; height: 90px;
        border-radius: 50%;
        background: rgba(8,14,24,0.88);
        border: 2px solid rgba(255,255,255,0.15);
        display: flex; align-items: center; justify-content: center;
        flex-direction: column;
        font-family: 'Consolas', monospace;
        color: #e0ecff;
        transition: transform 0.1s, border 0.1s, background 0.1s;
      }
      .ew-slot.hover {
        background: rgba(40,60,90,0.95);
        border-color: #ffcc44;
        transform: scale(1.15) translate(var(--ew-dx), var(--ew-dy));
      }
      .ew-icon { font-size: 34px; line-height: 1; }
      .ew-label { font-size: 10px; letter-spacing: 0.12em; margin-top: 4px; }
    `;
    document.head.appendChild(s);
  }

  return state.wheelContainer;
}

function buildWheel(): void {
  const wheel = ensureWheel();
  const profile = getProfile();
  const equipped = profile.equipped.activeEmotes.slice(0, 4);

  wheel.innerHTML = `
    <div class="ew-bg"></div>
    <div class="ew-title">EMOTE WHEEL</div>
    ${equipped.map((id, i) => {
      const def = EMOTES[id];
      if (!def) return '';
      const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const r = 110;
      const dx = Math.cos(angle) * r;
      const dy = Math.sin(angle) * r;
      return `<div class="ew-slot" data-idx="${i}" style="transform: translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)); --ew-dx: 0px; --ew-dy: 0px;">
        <div class="ew-icon">${def.icon}</div>
        <div class="ew-label">${def.name}</div>
      </div>`;
    }).join('')}
  `;
  wheel.classList.add('active');
  state.wheelVisible = true;
}

function updateWheelSelection(): void {
  if (!state.wheelVisible) return;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const dx = state.wheelX - cx;
  const dy = state.wheelY - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 30) {
    state.wheelSelection = null;
    state.wheelContainer?.querySelectorAll('.ew-slot').forEach(el => el.classList.remove('hover'));
    return;
  }
  const angle = Math.atan2(dy, dx) + Math.PI / 2;
  const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
  const idx = Math.floor((normalized / (Math.PI * 2)) * 4 + 0.5) % 4;
  state.wheelSelection = idx;
  state.wheelContainer?.querySelectorAll('.ew-slot').forEach(el => {
    const i = parseInt(el.getAttribute('data-idx') ?? '-1', 10);
    el.classList.toggle('hover', i === idx);
  });
}

function hideWheel(): number | null {
  state.wheelVisible = false;
  if (state.wheelContainer) {
    state.wheelContainer.classList.remove('active');
    state.wheelContainer.innerHTML = '';
  }
  return state.wheelSelection;
}

// ─────────────────────────────────────────────────────────────────────
//  SPRAY SYSTEM
// ─────────────────────────────────────────────────────────────────────

const _tmpRay = new THREE.Raycaster();

export function placeSpray(sprayId: string, camera: THREE.Camera): boolean {
  const scene = gameState.scene as THREE.Scene | undefined;
  if (!scene) return false;

  const def = SPRAYS[sprayId];
  if (!def) return false;

  _tmpRay.setFromCamera(new THREE.Vector2(0, 0), camera);

  // Raycast against scene (walls, floors)
  const intersects = _tmpRay.intersectObjects(scene.children, true).filter(h => {
    // Skip bots/player/particles
    let skip = false;
    let parent: THREE.Object3D | null = h.object;
    while (parent) {
      if ((parent as any).userData?.agent || (parent as any).userData?.isPlayer) skip = true;
      parent = parent.parent;
    }
    return !skip;
  });

  if (intersects.length === 0) return false;
  const hit = intersects[0];
  if (hit.distance > 8) return false; // spray range limit

  // Build SVG into data URI
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">${def.svgInner}</svg>`;
  const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  const loader = new THREE.TextureLoader();
  loader.load(dataUri, (tex) => {
    tex.minFilter = THREE.LinearFilter;
    const geo = new THREE.PlaneGeometry(0.8, 0.8);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, side: THREE.DoubleSide,
      opacity: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);

    // Orient plane to face away from hit surface (along normal)
    mesh.position.copy(hit.point);
    if (hit.face) {
      const normal = hit.face.normal.clone();
      normal.transformDirection(hit.object.matrixWorld);
      mesh.lookAt(hit.point.clone().add(normal));
      mesh.position.addScaledVector(normal, 0.01); // offset to avoid z-fighting
    }
    scene.add(mesh);

    state.sprays.push({ mesh, createdAt: performance.now() / 1000, lifetimeSec: 30 });
  });

  return true;
}

export function updateSprays(): void {
  const now = performance.now() / 1000;
  for (let i = state.sprays.length - 1; i >= 0; i--) {
    const s = state.sprays[i];
    const age = now - s.createdAt;
    if (age >= s.lifetimeSec) {
      s.mesh.parent?.remove(s.mesh);
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
      state.sprays.splice(i, 1);
    } else if (age >= s.lifetimeSec - 3) {
      // Fade out last 3s
      (s.mesh.material as any).opacity = (s.lifetimeSec - age) / 3;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
//  INPUT
// ─────────────────────────────────────────────────────────────────────

let cameraRef: THREE.Camera | null = null;

export function initEmotes(camera: THREE.Camera): void {
  cameraRef = camera;
  ensureWheel();

  window.addEventListener('mousemove', (e) => {
    state.wheelX = e.clientX;
    state.wheelY = e.clientY;
    if (state.wheelVisible) updateWheelSelection();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyB' && !e.repeat && !state.wheelVisible) {
      state.holdStart = performance.now();
      setTimeout(() => {
        if (state.holdStart > 0 && performance.now() - state.holdStart >= 150 && !state.wheelVisible) {
          buildWheel();
          updateWheelSelection();
        }
      }, 150);
    }
    if (e.code === 'KeyT' && !e.repeat) {
      // Quick-spray using first equipped spray
      const profile = getProfile();
      const sprayId = profile.equipped.activeSprays?.[0] ?? 'smiley';
      if (cameraRef) placeSpray(sprayId, cameraRef);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'KeyB') return;
    const heldMs = performance.now() - state.holdStart;
    state.holdStart = 0;

    if (state.wheelVisible) {
      const selected = hideWheel();
      if (selected !== null) {
        const profile = getProfile();
        const emoteId = profile.equipped.activeEmotes[selected];
        if (emoteId) playEmote(emoteId);
      }
    } else if (heldMs < 150) {
      // Quick tap → first emote
      const profile = getProfile();
      const emoteId = profile.equipped.activeEmotes[0];
      if (emoteId) playEmote(emoteId);
    }
  });
}

export function isEmoteActive(): boolean {
  return state.active !== null;
}