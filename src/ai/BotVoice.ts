/**
 * BotVoice — contextual bot callout system.
 *
 * Replaces the 3-kind SoundHooks.playBotCallout (spotted/reload/help) with
 * ~25 contextual lines across multiple moods: aggressive, defensive, panicked,
 * tactical, celebratory, taunting.
 *
 * Design:
 *   - Each "callout" is a semantic intent (e.g. "pushing_left")
 *   - Each intent has 2-4 text variants and a matching voice profile
 *   - Voice profiles use Web Speech API synthesis with pitch/rate variation
 *     tied to the bot's Personality (aggressive = faster/lower, cautious =
 *     slower/higher, tactical = neutral)
 *   - Calls are rate-limited per-bot and globally to avoid spam
 *   - Distance-based volume (louder when closer to player)
 *
 * Integration:
 *   - AIController state transitions trigger callouts via triggerCallout()
 *   - BRBrain decisions trigger contextual lines (engaging/disengaging)
 *   - Combat.ts fires kill/death callouts
 *
 * The subtitle system shows the line as a radio-style overlay.
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { Audio } from '@/audio/AudioManager';

export type CalloutKind =
  // Spotting
  | 'enemy_spotted' | 'sniper_spotted' | 'multiple_enemies'
  // Tactical
  | 'pushing_left' | 'pushing_right' | 'pushing_middle'
  | 'holding_position' | 'flanking' | 'regrouping'
  | 'going_loud' | 'going_quiet'
  // Status
  | 'reloading' | 'need_backup' | 'low_health' | 'last_one' | 'im_down'
  // Combat
  | 'got_him' | 'kill_confirm' | 'headshot_brag' | 'collateral'
  | 'revenge_time' | 'payback'
  // Panic
  | 'grenade' | 'flashbang' | 'taking_fire' | 'man_down'
  // Objectives
  | 'flag_taken' | 'flag_dropped' | 'objective_secured'
  // Taunts
  | 'taunt_easy' | 'taunt_missed' | 'taunt_try_again'
  // Response
  | 'roger' | 'negative' | 'on_it';

type Mood = 'calm' | 'alert' | 'aggressive' | 'panicked' | 'cocky';

interface CalloutDef {
  lines: string[];
  mood: Mood;
  priority: number;       // 0-10, higher interrupts lower
  radioLabel?: string;    // shown in subtitle
  cooldownMs: number;     // per-bot cooldown for this specific kind
}

const CALLOUTS: Record<CalloutKind, CalloutDef> = {
  enemy_spotted: {
    lines: ['Contact, I got eyes!', 'Enemy spotted!', 'Target acquired.', 'Hostile, ten o\'clock!'],
    mood: 'alert', priority: 5, cooldownMs: 8000,
  },
  sniper_spotted: {
    lines: ['Sniper! Get down!', 'Watch the rooftops!', 'Marksman, take cover!'],
    mood: 'alert', priority: 7, cooldownMs: 12000,
  },
  multiple_enemies: {
    lines: ['Multiple hostiles!', 'Whole squad here!', 'They\'re all over us!'],
    mood: 'alert', priority: 6, cooldownMs: 10000,
  },
  pushing_left: {
    lines: ['Pushing left!', 'Moving left side.', 'Going wide left.'],
    mood: 'aggressive', priority: 3, cooldownMs: 15000,
  },
  pushing_right: {
    lines: ['Pushing right!', 'Moving right flank.', 'I got the right.'],
    mood: 'aggressive', priority: 3, cooldownMs: 15000,
  },
  pushing_middle: {
    lines: ['Going through the middle!', 'Pushing center.', 'Straight up the gut!'],
    mood: 'aggressive', priority: 3, cooldownMs: 15000,
  },
  holding_position: {
    lines: ['Holding position.', 'I\'m on overwatch.', 'Locked down.'],
    mood: 'calm', priority: 2, cooldownMs: 20000,
  },
  flanking: {
    lines: ['Going for the flank.', 'Moving around, cover me.', 'Flanking from the side.'],
    mood: 'aggressive', priority: 4, cooldownMs: 15000,
  },
  regrouping: {
    lines: ['Falling back, regroup!', 'Pull back on me!', 'Consolidate on my position!'],
    mood: 'alert', priority: 5, cooldownMs: 15000,
  },
  going_loud: {
    lines: ['Going loud!', 'No more hiding!', 'Light \'em up!'],
    mood: 'aggressive', priority: 4, cooldownMs: 12000,
  },
  going_quiet: {
    lines: ['Going dark.', 'Quiet from here.', 'Radio silence.'],
    mood: 'calm', priority: 2, cooldownMs: 20000,
  },
  reloading: {
    lines: ['Reloading!', 'Mag out, cover me!', 'Changing mags!', 'Running dry!'],
    mood: 'alert', priority: 6, cooldownMs: 6000,
  },
  need_backup: {
    lines: ['Need backup!', 'Someone get over here!', 'I need help!', 'Pinned down, help!'],
    mood: 'panicked', priority: 8, cooldownMs: 10000,
  },
  low_health: {
    lines: ['I\'m hurt!', 'Taking too much damage!', 'I\'m bleeding out here!'],
    mood: 'panicked', priority: 7, cooldownMs: 8000,
  },
  last_one: {
    lines: ['He\'s the last one!', 'One left!', 'Finish him!'],
    mood: 'cocky', priority: 6, cooldownMs: 8000,
  },
  im_down: {
    lines: ['I\'m down!', 'Man down!', 'I\'m out!'],
    mood: 'panicked', priority: 9, cooldownMs: 1000,
  },
  got_him: {
    lines: ['Got him!', 'Target down.', 'One less!', 'That\'s a kill.'],
    mood: 'cocky', priority: 4, cooldownMs: 5000,
  },
  kill_confirm: {
    lines: ['Tango down!', 'Threat eliminated.', 'Clean kill.'],
    mood: 'calm', priority: 4, cooldownMs: 5000,
  },
  headshot_brag: {
    lines: ['Headshot! Easy!', 'Right between the eyes!', 'One-tap, baby!'],
    mood: 'cocky', priority: 5, cooldownMs: 10000,
  },
  collateral: {
    lines: ['Two birds, one stone!', 'Double kill!', 'Collateral!'],
    mood: 'cocky', priority: 6, cooldownMs: 10000,
  },
  revenge_time: {
    lines: ['That\'s mine!', 'Payback time!', 'I remember you!'],
    mood: 'aggressive', priority: 5, cooldownMs: 10000,
  },
  payback: {
    lines: ['Revenge!', 'Got you back!', 'We\'re even now!'],
    mood: 'cocky', priority: 5, cooldownMs: 10000,
  },
  grenade: {
    lines: ['Grenade!', 'Frag out!', 'Get clear!', 'Nade!'],
    mood: 'panicked', priority: 9, cooldownMs: 4000,
  },
  flashbang: {
    lines: ['Flash!', 'I\'m blind!', 'Can\'t see!'],
    mood: 'panicked', priority: 8, cooldownMs: 5000,
  },
  taking_fire: {
    lines: ['Taking fire!', 'Under attack!', 'They\'re shooting at me!'],
    mood: 'alert', priority: 6, cooldownMs: 6000,
  },
  man_down: {
    lines: ['Teammate down!', 'We lost one!', 'He\'s gone!'],
    mood: 'alert', priority: 7, cooldownMs: 5000,
  },
  flag_taken: {
    lines: ['They got our flag!', 'Flag down!', 'Recover the flag!'],
    mood: 'alert', priority: 8, cooldownMs: 10000,
  },
  flag_dropped: {
    lines: ['Flag dropped!', 'Grab the flag!', 'Pick it up!'],
    mood: 'alert', priority: 7, cooldownMs: 8000,
  },
  objective_secured: {
    lines: ['Objective secured!', 'We got it!', 'Point is ours!'],
    mood: 'cocky', priority: 5, cooldownMs: 10000,
  },
  taunt_easy: {
    lines: ['Too easy.', 'Is that all you got?', 'Amateur hour.'],
    mood: 'cocky', priority: 3, cooldownMs: 25000,
  },
  taunt_missed: {
    lines: ['You missed!', 'Nice shot, NOT.', 'Can\'t hit the broad side!'],
    mood: 'cocky', priority: 2, cooldownMs: 25000,
  },
  taunt_try_again: {
    lines: ['Try again!', 'Step it up!', 'Come on!'],
    mood: 'cocky', priority: 2, cooldownMs: 25000,
  },
  roger: {
    lines: ['Roger that.', 'Copy.', 'On it.', 'Understood.'],
    mood: 'calm', priority: 2, cooldownMs: 8000,
  },
  negative: {
    lines: ['Negative!', 'Can\'t do it!', 'No can do.'],
    mood: 'calm', priority: 2, cooldownMs: 10000,
  },
  on_it: {
    lines: ['On it!', 'Moving!', 'I got it!'],
    mood: 'calm', priority: 2, cooldownMs: 8000,
  },
};

// ─────────────────────────────────────────────────────────────────────
//  VOICE POOL — assign each bot a voice profile on first callout
// ─────────────────────────────────────────────────────────────────────

interface VoiceProfile {
  pitch: number;    // 0.6 - 1.4
  rate: number;     // 0.8 - 1.3
  baseVol: number;  // 0.55 - 1.0
  voiceIdx: number; // index into speechSynthesis.getVoices()
}

const VOICE_POOL: VoiceProfile[] = [];
let voicesCached: SpeechSynthesisVoice[] = [];

function refreshVoices(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  voicesCached = window.speechSynthesis.getVoices();
  // Prefer English voices
  const english = voicesCached
    .map((_, i) => i)
    .filter(i => voicesCached[i].lang.startsWith('en'));
  const idxPool = english.length > 0 ? english : voicesCached.map((_, i) => i);

  VOICE_POOL.length = 0;
  for (const vi of idxPool) {
    for (let p = 0; p < 3; p++) {
      VOICE_POOL.push({
        pitch: 0.65 + p * 0.25 + (Math.random() * 0.1),
        rate: 0.92 + Math.random() * 0.2,
        baseVol: 0.6 + Math.random() * 0.25,
        voiceIdx: vi,
      });
    }
  }
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  refreshVoices();
  window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
}

const botVoiceMap = new Map<string, VoiceProfile>();

function getVoiceFor(botId: string): VoiceProfile {
  let v = botVoiceMap.get(botId);
  if (!v) {
    if (VOICE_POOL.length === 0) refreshVoices();
    v = VOICE_POOL[Math.floor(Math.random() * Math.max(1, VOICE_POOL.length))]
      ?? { pitch: 1, rate: 1, baseVol: 0.7, voiceIdx: 0 };
    botVoiceMap.set(botId, v);
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────
//  COOLDOWNS
// ─────────────────────────────────────────────────────────────────────

// Per-bot per-kind cooldowns: Map<botId-kind, expiryMs>
const cooldowns = new Map<string, number>();
// Global spacing: don't stack callouts rapidly
let lastGlobalCallout = 0;
const GLOBAL_MIN_GAP_MS = 900;

// Priority preemption — if a higher-priority line fires, cancel the current one
let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentPriority = -1;

// ─────────────────────────────────────────────────────────────────────
//  SUBTITLE / RADIO OVERLAY
// ─────────────────────────────────────────────────────────────────────

let subEl: HTMLDivElement | null = null;

function ensureSubtitle(): HTMLDivElement {
  if (subEl) return subEl;
  subEl = document.createElement('div');
  subEl.id = 'botVoiceRadio';
  document.body.appendChild(subEl);

  const s = document.createElement('style');
  s.textContent = `
    #botVoiceRadio {
      position: fixed; left: 50%; bottom: 26%;
      transform: translateX(-50%);
      z-index: 9;
      pointer-events: none;
      display: flex; flex-direction: column; gap: 4px;
      align-items: center;
      max-width: 540px;
    }
    .bv-line {
      background: linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(8,14,24,0.9) 20%, rgba(8,14,24,0.9) 80%, rgba(0,0,0,0) 100%);
      color: #d9f0ff;
      padding: 4px 18px;
      font-family: 'Consolas', 'JetBrains Mono', monospace;
      font-size: 12px;
      letter-spacing: 0.06em;
      white-space: nowrap;
      opacity: 0;
      animation: bvIn 0.2s ease-out forwards, bvOut 0.4s ease-in forwards 3.6s;
      border-left: 2px solid;
    }
    .bv-line.team-blue { border-left-color: #4a9eff; }
    .bv-line.team-red { border-left-color: #ff5544; }
    .bv-name {
      color: #ffcc44; font-weight: 700; margin-right: 8px;
      text-shadow: 0 0 6px rgba(255,204,68,0.4);
    }
    .bv-mood-panicked .bv-name { color: #ff7755; }
    .bv-mood-cocky .bv-name { color: #55ffaa; }
    .bv-mood-aggressive .bv-name { color: #ff9933; }
    @keyframes bvIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes bvOut {
      to { opacity: 0; transform: translateY(-4px); }
    }
  `;
  document.head.appendChild(s);
  return subEl;
}

function showSubtitle(botName: string, team: 'blue' | 'red' | null, line: string, mood: Mood): void {
  const el = ensureSubtitle();
  const div = document.createElement('div');
  div.className = `bv-line ${team ? `team-${team}` : ''} bv-mood-${mood}`;
  div.innerHTML = `<span class="bv-name">${botName}:</span>${line}`;
  el.appendChild(div);

  // Limit to 3 concurrent
  while (el.children.length > 3) el.firstChild?.remove();

  // Auto-cleanup
  setTimeout(() => div.remove(), 4200);
}

// ─────────────────────────────────────────────────────────────────────
//  MAIN API
// ─────────────────────────────────────────────────────────────────────

export interface CalloutSource {
  id: string;
  name: string;
  team: 'blue' | 'red' | null;
  position: THREE.Vector3;
  // Optional personality hints to color the delivery
  personality?: { aggression?: number; cautiousness?: number; chatter?: number };
}

/**
 * Trigger a callout from a bot. Handles cooldowns, distance attenuation,
 * priority preemption, TTS playback, and subtitle overlay.
 */
export function triggerCallout(source: CalloutSource, kind: CalloutKind): boolean {
  const def = CALLOUTS[kind];
  if (!def) return false;

  const now = performance.now();

  // Chatter personality multiplier — quiet bots speak less
  const chatter = source.personality?.chatter ?? 0.6;
  if (Math.random() > chatter && def.priority < 6) return false;

  // Per-bot-per-kind cooldown
  const cdKey = `${source.id}:${kind}`;
  const cdExp = cooldowns.get(cdKey) ?? 0;
  if (now < cdExp) return false;

  // Global gap — unless high priority
  if (def.priority < 7 && now - lastGlobalCallout < GLOBAL_MIN_GAP_MS) return false;

  // Priority preemption
  if (currentUtterance && def.priority <= currentPriority) return false;

  cooldowns.set(cdKey, now + def.cooldownMs);
  lastGlobalCallout = now;

  // Pick a line
  const line = def.lines[Math.floor(Math.random() * def.lines.length)];

  // Compute distance volume attenuation from player camera
  const player = gameState.player;
  let volMul = 1;
  if (player) {
    const dist = source.position.distanceTo(player.renderComponent?.position ?? new THREE.Vector3());
    // Callouts audible out to ~60m, full volume within 15m
    volMul = Math.max(0.15, Math.min(1, 1 - (dist - 15) / 45));
  }

  // TTS playback
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      // Cancel lower-priority current utterance
      if (currentUtterance && def.priority > currentPriority) {
        window.speechSynthesis.cancel();
      }

      const voice = getVoiceFor(source.id);
      const u = new SpeechSynthesisUtterance(line);

      // Mood-shifts on top of voice profile
      let pitchAdj = 0, rateAdj = 0;
      switch (def.mood) {
        case 'aggressive': pitchAdj = -0.1; rateAdj = 0.15; break;
        case 'panicked':   pitchAdj = 0.25; rateAdj = 0.3;  break;
        case 'cocky':      pitchAdj = 0.0;  rateAdj = -0.05; break;
        case 'alert':      pitchAdj = 0.1;  rateAdj = 0.1;  break;
        case 'calm':       pitchAdj = 0;    rateAdj = 0;    break;
      }

      u.pitch = Math.max(0.3, Math.min(1.8, voice.pitch + pitchAdj));
      u.rate = Math.max(0.6, Math.min(1.6, voice.rate + rateAdj));
      u.volume = voice.baseVol * volMul * Audio.voiceVolume * Audio.masterVolume;
      if (voicesCached[voice.voiceIdx]) u.voice = voicesCached[voice.voiceIdx];

      u.onstart = () => { currentUtterance = u; currentPriority = def.priority; };
      u.onend = () => {
        if (currentUtterance === u) { currentUtterance = null; currentPriority = -1; }
      };
      u.onerror = u.onend;

      window.speechSynthesis.speak(u);
    } catch {
      // TTS unavailable — fall through to subtitle-only
    }
  }

  // Subtitle
  showSubtitle(source.name, source.team, line, def.mood);
  return true;
}

/**
 * Force-clear all queued voice. Call on match end / scene change.
 */
export function clearAllCallouts(): void {
  try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
  currentUtterance = null;
  currentPriority = -1;
  cooldowns.clear();
  if (subEl) subEl.innerHTML = '';
}

/**
 * Convenience wrappers for common scenarios.
 */
export const BotVoice = {
  onSpotEnemy(src: CalloutSource, targetIsSniper: boolean, multiEnemies: boolean): void {
    if (multiEnemies) triggerCallout(src, 'multiple_enemies');
    else if (targetIsSniper) triggerCallout(src, 'sniper_spotted');
    else triggerCallout(src, 'enemy_spotted');
  },
  onReload(src: CalloutSource): void {
    triggerCallout(src, 'reloading');
  },
  onKill(src: CalloutSource, isHeadshot: boolean, isCollateral: boolean, isRevenge: boolean): void {
    if (isCollateral) triggerCallout(src, 'collateral');
    else if (isRevenge) triggerCallout(src, 'payback');
    else if (isHeadshot && Math.random() < 0.4) triggerCallout(src, 'headshot_brag');
    else triggerCallout(src, Math.random() < 0.5 ? 'got_him' : 'kill_confirm');
  },
  onDeath(src: CalloutSource): void {
    triggerCallout(src, 'im_down');
  },
  onLowHp(src: CalloutSource, critical: boolean): void {
    triggerCallout(src, critical ? 'need_backup' : 'low_health');
  },
  onGrenade(src: CalloutSource, flash: boolean): void {
    triggerCallout(src, flash ? 'flashbang' : 'grenade');
  },
  onPush(src: CalloutSource, direction: 'left' | 'right' | 'middle'): void {
    triggerCallout(src, direction === 'left' ? 'pushing_left' : direction === 'right' ? 'pushing_right' : 'pushing_middle');
  },
  onFlank(src: CalloutSource): void {
    triggerCallout(src, 'flanking');
  },
  onLastEnemy(src: CalloutSource): void {
    triggerCallout(src, 'last_one');
  },
  onObjective(src: CalloutSource, kind: 'taken' | 'dropped' | 'secured'): void {
    triggerCallout(src, kind === 'taken' ? 'flag_taken' : kind === 'dropped' ? 'flag_dropped' : 'objective_secured');
  },
  onTaunt(src: CalloutSource): void {
    const pool: CalloutKind[] = ['taunt_easy', 'taunt_missed', 'taunt_try_again'];
    triggerCallout(src, pool[Math.floor(Math.random() * pool.length)]);
  },
};