/**
 * AudioManager — Web Audio API mixer.
 *
 * Two modes:
 *   - SYNTH (default): procedurally generated sounds. Works with zero assets.
 *   - SAMPLES: drop in WAVs/OGGs at /public/audio/<name>.wav and they take over.
 *
 * 3D spatial audio for world events (shots, footsteps), 2D for UI.
 *
 * Drop real assets later — register them in REAL_SOUND_URLS and they'll
 * automatically replace the synth versions.
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';

type SoundCategory = 'sfx' | 'voice' | 'music' | 'ui';

interface SoundDef {
  category: SoundCategory;
  /** Base volume 0..1 */
  volume: number;
  /** If true, can play overlapping copies */
  polyphonic?: boolean;
  /** Synth function used when no sample is loaded */
  synth: (ctx: AudioContext, dest: AudioNode) => number; // returns duration
}

interface PlayOpts {
  /** World position for 3D positional audio. Omit for 2D. */
  pos?: THREE.Vector3 | { x: number; y: number; z: number };
  /** 0..1 multiplier on top of base volume */
  volume?: number;
  /** Random pitch variation, e.g. 0.1 = ±5% */
  pitchJitter?: number;
  /** Override pitch */
  pitch?: number;
}

// ─────────────────────────────────────────────────────────────────────
//  CORE
// ─────────────────────────────────────────────────────────────────────

class AudioMgr {
  ctx: AudioContext | null = null;
  listener: AudioListener | null = null;
  masterGain!: GainNode;
  busSfx!: GainNode;
  busVoice!: GainNode;
  busMusic!: GainNode;
  busUi!: GainNode;
  compressor!: DynamicsCompressorNode;

  private samples = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private playingLoops = new Map<string, AudioBufferSourceNode>();

  enabled = true;
  initialized = false;

  // User-adjustable
  masterVolume = 0.7;
  sfxVolume = 1.0;
  voiceVolume = 1.0;
  musicVolume = 0.5;
  uiVolume = 0.8;

  init(): void {
    if (this.initialized) return;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.listener = this.ctx.listener;

      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 24;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.25;
      this.compressor.connect(this.ctx.destination);

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.compressor);

      this.busSfx = this.ctx.createGain();
      this.busSfx.gain.value = this.sfxVolume;
      this.busSfx.connect(this.masterGain);

      this.busVoice = this.ctx.createGain();
      this.busVoice.gain.value = this.voiceVolume;
      this.busVoice.connect(this.masterGain);

      this.busMusic = this.ctx.createGain();
      this.busMusic.gain.value = this.musicVolume;
      this.busMusic.connect(this.masterGain);

      this.busUi = this.ctx.createGain();
      this.busUi.gain.value = 0.8;
      this.busUi.connect(this.masterGain);

      this.initialized = true;

      // Try to load real assets if present. This keeps running in the
      // background, and match loading can explicitly await combat-critical
      // sounds through preloadSamples().
      void this.preloadRealAssets();
    } catch (e) {
      console.warn('[Audio] Failed to init:', e);
      this.enabled = false;
    }
  }

  /** Web Audio requires a user gesture to start. Call on first click/key. */
  async resume(): Promise<void> {
    if (!this.ctx) this.init();
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  setMaster(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.masterVolume;
  }
  setSfx(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.busSfx) this.busSfx.gain.value = this.sfxVolume;
  }
  setMusic(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.busMusic) this.busMusic.gain.value = this.musicVolume;
  }
  setVoice(v: number): void {
    this.voiceVolume = Math.max(0, Math.min(1, v));
    if (this.busVoice) this.busVoice.gain.value = this.voiceVolume;
  }
  setUi(v: number): void {
    this.uiVolume = Math.max(0, Math.min(1, v));
    if (this.busUi) this.busUi.gain.value = this.uiVolume;
  }

  // ── Sample loading ──

  private async preloadRealAssets(): Promise<void> {
    const BASE = (import.meta as any).env?.BASE_URL ?? '/';
    for (const [id, file] of Object.entries(REAL_SOUND_URLS)) {
      this.loadSample(id, `${BASE}audio/${file}`).catch(() => {
        // Silent fail — synth fallback will be used
      });
    }
  }

  async preloadSamples(ids: readonly string[]): Promise<void> {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    const BASE = (import.meta as any).env?.BASE_URL ?? '/';
    await Promise.all(ids.map(async (id) => {
      const file = REAL_SOUND_URLS[id];
      if (!file) return;
      await this.loadSample(id, `${BASE}audio/${file}`).catch(() => {
        // Silent fail - synth fallback will be used.
      });
    }));
  }

  async loadSample(id: string, url: string): Promise<AudioBuffer | null> {
    if (this.samples.has(id)) return this.samples.get(id)!;
    const existing = this.loading.get(id);
    if (existing) return existing;
    if (!this.ctx) return null;

    const promise = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        const buf = await this.ctx!.decodeAudioData(arr);
        this.samples.set(id, buf);
        return buf;
      } catch {
        return null;
      }
    })();
    this.loading.set(id, promise);
    return promise;
  }

  // ── Listener position update (called from game loop) ──

  updateListener(pos: THREE.Vector3, forward: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)): void {
    if (!this.listener) return;
    if (this.listener.positionX) {
      this.listener.positionX.value = pos.x;
      this.listener.positionY.value = pos.y;
      this.listener.positionZ.value = pos.z;
      this.listener.forwardX.value = forward.x;
      this.listener.forwardY.value = forward.y;
      this.listener.forwardZ.value = forward.z;
      this.listener.upX.value = up.x;
      this.listener.upY.value = up.y;
      this.listener.upZ.value = up.z;
    } else {
      // Old API
      (this.listener as any).setPosition(pos.x, pos.y, pos.z);
      (this.listener as any).setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  // ── Play ──

  play(id: string, opts: PlayOpts = {}): void {
    if (!this.enabled || !this.ctx || !this.initialized) return;
    const def = SOUNDS[id];
    if (!def) return;

    const bus =
      def.category === 'sfx' ? this.busSfx :
      def.category === 'voice' ? this.busVoice :
      def.category === 'music' ? this.busMusic : this.busUi;

    // Per-call gain
    const callGain = this.ctx.createGain();
    callGain.gain.value = (opts.volume ?? 1) * def.volume;

    let dest: AudioNode = bus;
    let panner: PannerNode | null = null;

    // 3D positional
    if (opts.pos) {
      // PERF: HRTF panning is roughly 4× more expensive than equalpower
      // and the difference is inaudible for combat sounds at high rates.
      // Switch to 'equalpower' which uses a cheap stereo pan algorithm.
      panner = this.ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 4;
      panner.maxDistance = 80;
      panner.rolloffFactor = 1.4;
      if (panner.positionX) {
        panner.positionX.value = opts.pos.x;
        panner.positionY.value = opts.pos.y;
        panner.positionZ.value = opts.pos.z;
      } else {
        (panner as any).setPosition(opts.pos.x, opts.pos.y, opts.pos.z);
      }
      panner.connect(callGain);
      callGain.connect(bus);
      dest = panner;
    } else {
      callGain.connect(bus);
      dest = callGain;
    }

    // Sample available?
    const buf = this.samples.get(id);
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const pitch = opts.pitch ?? (1 + (opts.pitchJitter ?? 0) * (Math.random() - 0.5) * 2);
      src.playbackRate.value = pitch;
      src.connect(dest);
      // PERF: disconnect all nodes as soon as playback completes,
      // otherwise Web Audio holds onto them until context GC — at
      // 100+ shots/sec the node graph was growing without bound and
      // eventually hitting the context node limit, producing audio
      // stalls + main-thread hitches.
      src.onended = () => {
        try { src.disconnect(); } catch { /* already detached */ }
        try { callGain.disconnect(); } catch { /* noop */ }
        if (panner) { try { panner.disconnect(); } catch { /* noop */ } }
      };
      src.start();
    } else {
      // Fall back to synth
      const duration = Math.max(0, def.synth(this.ctx, dest) || 0);
      window.setTimeout(() => {
        try { callGain.disconnect(); } catch { /* noop */ }
        if (panner) {
          try { panner.disconnect(); } catch { /* noop */ }
        }
      }, Math.max(50, (duration + 0.1) * 1000));
    }
  }

  /** Start a looping sound. Call stopLoop(id) to end. */
  loop(id: string, volume = 1): void {
    if (!this.enabled || !this.ctx) return;
    if (this.playingLoops.has(id)) return;
    const buf = this.samples.get(id);
    if (!buf) return; // Loops require real samples; synth loops are too expensive

    const def = SOUNDS[id];
    const bus =
      def?.category === 'music' ? this.busMusic :
      def?.category === 'voice' ? this.busVoice :
      def?.category === 'ui' ? this.busUi : this.busSfx;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = volume * (def?.volume ?? 1);
    src.connect(g);
    g.connect(bus);
    src.start();
    this.playingLoops.set(id, src);
  }

  /**
   * Play a track exactly once (no loop). Stored in playingLoops so it can
   * be cut short early via stopLoop(). Auto-removed when playback ends.
   */
  playOnce(id: string, volume = 1): void {
    if (!this.enabled || !this.ctx) return;
    if (this.playingLoops.has(id)) return;
    const buf = this.samples.get(id);
    if (!buf) return;

    const def = SOUNDS[id];
    const bus =
      def?.category === 'music' ? this.busMusic :
      def?.category === 'voice' ? this.busVoice :
      def?.category === 'ui' ? this.busUi : this.busSfx;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false;
    const g = this.ctx.createGain();
    g.gain.value = volume * (def?.volume ?? 1);
    src.connect(g);
    g.connect(bus);
    src.onended = () => {
      this.playingLoops.delete(id);
      try { src.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
    src.start();
    this.playingLoops.set(id, src);
  }

  stopLoop(id: string): void {
    const src = this.playingLoops.get(id);
    if (src) {
      src.stop();
      this.playingLoops.delete(id);
    }
  }

  // ── Ambient music drone ──
  private ambientNodes: OscillatorNode[] = [];
  private ambientPlaying = false;

  startAmbientMusic(): void {
    if (!this.ctx || this.ambientPlaying) return;
    this.ambientPlaying = true;

    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.busMusic);
    // Fade in
    gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 3);

    // Low drone — two detuned oscillators for thickness
    const freqs = [55, 55.3, 82.4]; // A1 + detuned + E2
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const oscGain = ctx.createGain();
      oscGain.gain.value = f > 60 ? 0.06 : 0.1;
      osc.connect(oscGain);
      oscGain.connect(gain);
      osc.start();
      this.ambientNodes.push(osc);
    }

    // Sub-bass pulse
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.15; // slow pulse
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain);
    lfoGain.connect(gain);
    lfo.start();
    this.ambientNodes.push(lfo);
  }

  stopAmbientMusic(): void {
    for (const osc of this.ambientNodes) {
      try { osc.stop(); } catch { /* already stopped */ }
    }
    this.ambientNodes = [];
    this.ambientPlaying = false;
  }

  // ── Environmental ambient layer ──
  private envNodes: (OscillatorNode | AudioBufferSourceNode)[] = [];
  private envPlaying = false;
  private envTimers: ReturnType<typeof setTimeout>[] = [];

  startEnvironmentAmbience(): void {
    if (!this.ctx || this.envPlaying) return;
    this.envPlaying = true;
    const ctx = this.ctx;

    const envGain = ctx.createGain();
    envGain.gain.value = 0;
    envGain.connect(this.busMusic);
    envGain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 4);

    // Wind: filtered white noise
    const windBuf = ctx.createBuffer(1, ctx.sampleRate * 8, ctx.sampleRate);
    const windData = windBuf.getChannelData(0);
    for (let i = 0; i < windData.length; i++) windData[i] = Math.random() * 2 - 1;
    const wind = ctx.createBufferSource();
    wind.buffer = windBuf;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 400;
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.06;
    wind.connect(windFilter).connect(windGain).connect(envGain);
    wind.start();
    this.envNodes.push(wind);

    // Distant gunfire bursts — periodic random shots
    const scheduleDistantShot = () => {
      if (!this.envPlaying || !this.ctx) return;
      const delay = 4000 + Math.random() * 12000;
      const timer = setTimeout(() => {
        if (!this.envPlaying || !this.ctx) return;
        const burstCount = 1 + Math.floor(Math.random() * 4);
        for (let i = 0; i < burstCount; i++) {
          setTimeout(() => {
            if (!this.ctx) return;
            const t = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(120 + Math.random() * 80, t);
            osc.frequency.exponentialRampToValueAtTime(60, t + 0.08);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.03, t + 0.002);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 600;
            osc.connect(lp).connect(g).connect(envGain);
            osc.start(t);
            osc.stop(t + 0.12);
          }, i * (80 + Math.random() * 60));
        }
        scheduleDistantShot();
      }, delay);
      this.envTimers.push(timer);
    };
    scheduleDistantShot();

    // Metallic creaks — filtered noise bursts every 8-20s
    const scheduleCreak = () => {
      if (!this.envPlaying || !this.ctx) return;
      const delay = 8000 + Math.random() * 12000;
      const timer = setTimeout(() => {
        if (!this.envPlaying || !this.ctx) return;
        const t = this.ctx.currentTime;
        const nBuf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
        const nData = nBuf.getChannelData(0);
        for (let i = 0; i < nData.length; i++) nData[i] = Math.random() * 2 - 1;
        const n = this.ctx.createBufferSource();
        n.buffer = nBuf;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1200 + Math.random() * 800;
        bp.Q.value = 8;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.02, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        n.connect(bp).connect(g).connect(envGain);
        n.start(t);
        n.stop(t + 0.35);
        scheduleCreak();
      }, delay);
      this.envTimers.push(timer);
    };
    scheduleCreak();
  }

  stopEnvironmentAmbience(): void {
    this.envPlaying = false;
    for (const n of this.envNodes) {
      try { n.stop(); } catch { /* already stopped */ }
    }
    this.envNodes = [];
    for (const t of this.envTimers) clearTimeout(t);
    this.envTimers = [];
  }
}

export const Audio = new AudioMgr();

// ─────────────────────────────────────────────────────────────────────
//  SYNTH PRIMITIVES
//  These build sounds using oscillators + noise + envelopes when no
//  real sample is loaded. They're not great — they're functional.
// ─────────────────────────────────────────────────────────────────────

function whiteNoise(ctx: AudioContext, duration: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * duration, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envelope(g: GainNode, t: number, attack: number, decay: number, peak: number): void {
  const p = g.gain;
  p.cancelScheduledValues(t);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function gunshot(ctx: AudioContext, dest: AudioNode, freq: number, dur: number, body: number): number {
  const t = ctx.currentTime;

  // Body: low-frequency thump
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq * 2.5, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + dur);
  const oscG = ctx.createGain();
  envelope(oscG, t, 0.001, dur * 0.6, body);
  osc.connect(oscG).connect(dest);
  osc.start(t);
  osc.stop(t + dur);

  // Crack: filtered noise burst
  const noise = ctx.createBufferSource();
  noise.buffer = whiteNoise(ctx, dur + 0.05);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 1200;
  const noiseG = ctx.createGain();
  envelope(noiseG, t, 0.001, dur * 0.4, 0.6);
  noise.connect(filter).connect(noiseG).connect(dest);
  noise.start(t);
  noise.stop(t + dur);

  return dur;
}

// ─────────────────────────────────────────────────────────────────────
//  SOUND LIBRARY
// ─────────────────────────────────────────────────────────────────────

const SOUNDS: Record<string, SoundDef> = {
  // ── Weapons (synthesized fallbacks) ──
  shot_pistol:   { category: 'sfx', volume: 0.55, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 320, 0.12, 0.7) },
  shot_smg:      { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 280, 0.10, 0.6) },
  shot_ar:       { category: 'sfx', volume: 0.50, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 240, 0.13, 0.75) },
  shot_shotgun:  { category: 'sfx', volume: 0.65, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 140, 0.22, 0.95) },
  shot_sniper:   { category: 'sfx', volume: 0.75, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 180, 0.30, 1.0) },
  shot_rocket:   { category: 'sfx', volume: 0.7, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 90, 0.45, 1.0) },
  shot_ak47:     { category: 'sfx', volume: 0.55, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 220, 0.14, 0.8) },
  shot_awp:      { category: 'sfx', volume: 0.8, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 160, 0.35, 1.0) },
  shot_scar:     { category: 'sfx', volume: 0.55, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 230, 0.14, 0.75) },
  shot_lmg:      { category: 'sfx', volume: 0.55, polyphonic: true,
    synth: (ctx, d) => gunshot(ctx, d, 200, 0.12, 0.7) },

  // ── Impacts ──
  impact_body:   { category: 'sfx', volume: 0.5, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.08);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 600; f.Q.value = 2;
      const g = ctx.createGain();
      envelope(g, t, 0.002, 0.06, 0.7);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.1);
      return 0.1;
    },
  },
  impact_headshot: { category: 'sfx', volume: 0.8, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      // Higher-pitch ping
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2200, t);
      osc.frequency.exponentialRampToValueAtTime(800, t + 0.08);
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.1, 0.5);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.15);
      return 0.15;
    },
  },
  impact_wall:   { category: 'sfx', volume: 0.4, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.05);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 2000;
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.04, 0.4);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.06);
      return 0.06;
    },
  },

  // ── Mechanical ──
  reload:        { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      // Click-clack
      for (const offset of [0, 0.18, 0.32]) {
        const noise = ctx.createBufferSource();
        noise.buffer = whiteNoise(ctx, 0.04);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 5;
        const g = ctx.createGain();
        envelope(g, t + offset, 0.001, 0.05, 0.3);
        noise.connect(f).connect(g).connect(d);
        noise.start(t + offset); noise.stop(t + offset + 0.06);
      }
      return 0.4;
    },
  },
  reload_pistol: { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (const offset of [0, 0.15]) {
        const noise = ctx.createBufferSource();
        noise.buffer = whiteNoise(ctx, 0.03);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 5;
        const g = ctx.createGain();
        envelope(g, t + offset, 0.001, 0.04, 0.3);
        noise.connect(f).connect(g).connect(d);
        noise.start(t + offset); noise.stop(t + offset + 0.05);
      }
      return 0.25;
    },
  },
  reload_smg:    { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  load_smg:      { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  reload_ar:     { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  load_ar:       { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  reload_shotgun: { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (const offset of [0, 0.25, 0.50, 0.75]) {
        const noise = ctx.createBufferSource();
        noise.buffer = whiteNoise(ctx, 0.04);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 4;
        const g = ctx.createGain();
        envelope(g, t + offset, 0.001, 0.05, 0.35);
        noise.connect(f).connect(g).connect(d);
        noise.start(t + offset); noise.stop(t + offset + 0.06);
      }
      return 1.0;
    },
  },
  reload_sniper: { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  load_sniper:   { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  reload_rocket: { category: 'sfx', volume: 0.6,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  reload_lmg:    { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => SOUNDS.reload.synth(ctx, d) },
  shotgun_cock:  { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.08);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 3;
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.07, 0.4);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.1);
      return 0.1;
    },
  },
  sniper_zoom:   { category: 'sfx', volume: 0.35,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = 600;
      const g = ctx.createGain();
      envelope(g, t, 0.01, 0.15, 0.2);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.18);
      return 0.18;
    },
  },
  weapon_swap:   { category: 'sfx', volume: 0.4,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.08);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 3;
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.08, 0.35);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.1);
      return 0.1;
    },
  },
  empty_click:   { category: 'sfx', volume: 0.4,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.02);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 3000;
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.02, 0.5);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.03);
      return 0.03;
    },
  },

  // ── Bullet whiz/flyby (positional) ──
  bullet_whiz: { category: 'sfx', volume: 0.6, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.12);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.7, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      noise.connect(bp).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.13);
      return 0.13;
    },
  },

  // ── Kill confirmed chime (2D, non-positional) ──
  kill_confirmed: { category: 'sfx', volume: 0.5, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      // Rising two-tone chime
      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.setValueAtTime(1200, t);
      o1.frequency.setValueAtTime(1600, t + 0.06);
      const g1 = ctx.createGain();
      envelope(g1, t, 0.002, 0.12, 0.45);
      o1.connect(g1).connect(d);
      o1.start(t); o1.stop(t + 0.14);
      // Harmonic shimmer
      const o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.setValueAtTime(2400, t + 0.04);
      const g2 = ctx.createGain();
      envelope(g2, t + 0.04, 0.002, 0.08, 0.2);
      o2.connect(g2).connect(d);
      o2.start(t + 0.04); o2.stop(t + 0.14);
      return 0.14;
    },
  },

  // ── Hitmarker feedback (2D, non-positional) ──
  friendly_fire_buzz: { category: 'sfx', volume: 0.4, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.linearRampToValueAtTime(120, t + 0.12);
      const g = ctx.createGain();
      envelope(g, t, 0.003, 0.12, 0.35);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.15);
      return 0.15;
    },
  },
  hitmarker_body: { category: 'sfx', volume: 0.35, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(800, t);
      osc.frequency.exponentialRampToValueAtTime(400, t + 0.025);
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.025, 0.3);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.035);
      return 0.035;
    },
  },
  hitmarker_headshot: { category: 'sfx', volume: 0.5, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      // High metallic dink
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(2200, t);
      osc.frequency.exponentialRampToValueAtTime(1200, t + 0.03);
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.04, 0.45);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.05);
      // Second harmonic ping
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(3400, t);
      osc2.frequency.exponentialRampToValueAtTime(1800, t + 0.05);
      const g2 = ctx.createGain();
      envelope(g2, t, 0.001, 0.05, 0.2);
      osc2.connect(g2).connect(d);
      osc2.start(t); osc2.stop(t + 0.06);
      return 0.06;
    },
  },

  // ── Movement ──
  footstep:      { category: 'sfx', volume: 0.25, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.08);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 250;
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.06, 0.5);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.1);
      return 0.1;
    },
  },
  jump:          { category: 'sfx', volume: 0.3,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.1);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 400;
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.08, 0.5);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.12);
      return 0.12;
    },
  },
  land:          { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.12);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 200;
      const g = ctx.createGain();
      envelope(g, t, 0.002, 0.1, 0.7);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.15);
      return 0.15;
    },
  },
  slide:         { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.6);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 1.5;
      const g = ctx.createGain();
      const peak = 0.5;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.03);
      g.gain.linearRampToValueAtTime(peak * 0.7, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.62);
      return 0.6;
    },
  },

  // ── Damage / health ──
  hit_taken:     { category: 'sfx', volume: 0.55,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(60, t + 0.2);
      const g = ctx.createGain();
      envelope(g, t, 0.001, 0.18, 0.4);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.22);
      return 0.22;
    },
  },
  heal:          { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440 + i * 220, t + i * 0.04);
        const g = ctx.createGain();
        envelope(g, t + i * 0.04, 0.005, 0.12, 0.25);
        osc.connect(g).connect(d);
        osc.start(t + i * 0.04); osc.stop(t + i * 0.04 + 0.15);
      }
      return 0.25;
    },
  },
  pickup:        { category: 'sfx', volume: 0.4,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.linearRampToValueAtTime(880, t + 0.08);
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.1, 0.35);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.12);
      return 0.12;
    },
  },

  // ── UI ──
  ui_hover:      { category: 'ui', volume: 0.25,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 800;
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.05, 0.2);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.06);
      return 0.06;
    },
  },
  ui_confirm:    { category: 'ui', volume: 0.4,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.linearRampToValueAtTime(660, t + 0.06);
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.08, 0.4);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.1);
      return 0.1;
    },
  },
  ui_deny:       { category: 'ui', volume: 0.4,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.linearRampToValueAtTime(110, t + 0.12);
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.12, 0.35);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.15);
      return 0.15;
    },
  },

  // ── Music ──
  music_lobby:    { category: 'music', volume: 0.8, synth: (ctx, d) => { return 0; } },
  music_start:    { category: 'music', volume: 0.9, synth: (ctx, d) => { return 0; } },
  music_midmatch: { category: 'music', volume: 0.6, synth: (ctx, d) => { return 0; } },
  music_climax:   { category: 'music', volume: 0.9, synth: (ctx, d) => { return 0; } },
  music_victory:  { category: 'music', volume: 1.0, synth: (ctx, d) => { return 0; } },
  music_defeat:   { category: 'music', volume: 1.0, synth: (ctx, d) => { return 0; } },

  // ── Medals / announcer (tonal stingers) ──
  medal_silver: { category: 'voice', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (const [f, off] of [[523, 0], [659, 0.08]]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle'; osc.frequency.value = f;
        const g = ctx.createGain();
        envelope(g, t + off, 0.005, 0.18, 0.4);
        osc.connect(g).connect(d);
        osc.start(t + off); osc.stop(t + off + 0.2);
      }
      return 0.3;
    },
  },
  medal_gold: { category: 'voice', volume: 0.55,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (const [f, off] of [[523, 0], [659, 0.08], [784, 0.16]]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle'; osc.frequency.value = f;
        const g = ctx.createGain();
        envelope(g, t + off, 0.005, 0.22, 0.45);
        osc.connect(g).connect(d);
        osc.start(t + off); osc.stop(t + off + 0.25);
      }
      return 0.42;
    },
  },
  medal_epic: { category: 'voice', volume: 0.65,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (const [f, off] of [[523, 0], [659, 0.06], [784, 0.12], [1047, 0.20]]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth'; osc.frequency.value = f;
        const g = ctx.createGain();
        envelope(g, t + off, 0.005, 0.3, 0.4);
        osc.connect(g).connect(d);
        osc.start(t + off); osc.stop(t + off + 0.32);
      }
      return 0.55;
    },
  },
  victory: { category: 'voice', volume: 0.7,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const notes: [number, number][] = [[523, 0], [659, 0.15], [784, 0.30], [1047, 0.50]];
      for (const [f, off] of notes) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle'; osc.frequency.value = f;
        const g = ctx.createGain();
        envelope(g, t + off, 0.005, 0.4, 0.5);
        osc.connect(g).connect(d);
        osc.start(t + off); osc.stop(t + off + 0.45);
      }
      return 1.0;
    },
  },
  defeat: { category: 'voice', volume: 0.6,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const notes: [number, number][] = [[440, 0], [392, 0.2], [330, 0.4]];
      for (const [f, off] of notes) {
        const osc = ctx.createOscillator();
        osc.type = 'sine'; osc.frequency.value = f;
        const g = ctx.createGain();
        envelope(g, t + off, 0.005, 0.5, 0.5);
        osc.connect(g).connect(d);
        osc.start(t + off); osc.stop(t + off + 0.55);
      }
      return 0.95;
    },
  },
  announcer_tdm: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_eliminate: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_enemy_ahead: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_fight_back: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_finish_them: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_halfway: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_pressure: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_1min: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_secure: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_10sec: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_green: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_in_lead: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_lost_lead: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_taken_lead: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_double_kill: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_triple_kill: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_overkill: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_bloodthirsty: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_unstoppable: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  announcer_godlike: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  mission_accomplished: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  outstanding_work: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  mission_failed: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  returning_to_base: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  stand_down: { category: 'voice', volume: 0.8, synth: () => 0.5 },
  get_them_next_time: { category: 'voice', volume: 0.8, synth: () => 0.5 },

  // ── Voice callouts (placeholder beeps; swap with TTS lines) ──
  voice_enemy_spotted: { category: 'voice', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth'; osc.frequency.value = 660;
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.12, 0.3);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.14);
      return 0.14;
    },
  },
  voice_need_help: { category: 'voice', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (const off of [0, 0.1]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth'; osc.frequency.value = 440;
        const g = ctx.createGain();
        envelope(g, t + off, 0.005, 0.1, 0.3);
        osc.connect(g).connect(d);
        osc.start(t + off); osc.stop(t + off + 0.12);
      }
      return 0.22;
    },
  },
  voice_reloading: { category: 'voice', volume: 0.45,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth'; osc.frequency.value = 330;
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.15, 0.3);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.17);
      return 0.17;
    },
  },

  // ── Heartbeat (low HP) ──
  heartbeat: { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      for (const off of [0, 0.12]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(60, t + off);
        const g = ctx.createGain();
        envelope(g, t + off, 0.005, 0.1, 0.7);
        osc.connect(g).connect(d);
        osc.start(t + off); osc.stop(t + off + 0.13);
      }
      return 0.25;
    },
  },

  // ── Explosions ──
  explosion: { category: 'sfx', volume: 0.8, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = whiteNoise(ctx, 0.6);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(800, t);
      f.frequency.exponentialRampToValueAtTime(80, t + 0.5);
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.55, 1.0);
      noise.connect(f).connect(g).connect(d);
      noise.start(t); noise.stop(t + 0.6);

      // Sub-bass thump
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80, t);
      osc.frequency.exponentialRampToValueAtTime(30, t + 0.3);
      const og = ctx.createGain();
      envelope(og, t, 0.001, 0.3, 0.8);
      osc.connect(og).connect(d);
      osc.start(t); osc.stop(t + 0.32);
      return 0.6;
    },
  },

  // ── Footstep variants (real samples rotate; synth just uses base) ──
  footstep_1:    { category: 'sfx', volume: 0.25, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep.synth(ctx, d) },
  footstep_2:    { category: 'sfx', volume: 0.25, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep.synth(ctx, d) },
  footstep_3:    { category: 'sfx', volume: 0.25, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep.synth(ctx, d) },
  footstep_4:    { category: 'sfx', volume: 0.25, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep.synth(ctx, d) },
  footstep_5:    { category: 'sfx', volume: 0.25, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep.synth(ctx, d) },
  footstep_6:    { category: 'sfx', volume: 0.25, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep.synth(ctx, d) },

  // ── Metal footstep variants (higher-pitched, metallic ring) ──
  footstep_metal_1: { category: 'sfx', volume: 0.3, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator(); osc.type = 'square';
      osc.frequency.setValueAtTime(800 + Math.random() * 200, t);
      osc.frequency.exponentialRampToValueAtTime(300, t + 0.06);
      const g = ctx.createGain(); envelope(g, t, 0.002, 0.05, 0.3);
      osc.connect(g).connect(d); osc.start(t); osc.stop(t + 0.08); return 0.08;
    },
  },
  footstep_metal_2: { category: 'sfx', volume: 0.3, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep_metal_1.synth(ctx, d) },
  footstep_metal_3: { category: 'sfx', volume: 0.3, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep_metal_1.synth(ctx, d) },

  // ── Wood footstep variants (softer, lower thud) ──
  footstep_wood_1: { category: 'sfx', volume: 0.28, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator(); osc.type = 'triangle';
      osc.frequency.setValueAtTime(180 + Math.random() * 60, t);
      osc.frequency.exponentialRampToValueAtTime(80, t + 0.06);
      const g = ctx.createGain(); envelope(g, t, 0.003, 0.05, 0.4);
      osc.connect(g).connect(d); osc.start(t); osc.stop(t + 0.08); return 0.08;
    },
  },
  footstep_wood_2: { category: 'sfx', volume: 0.28, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep_wood_1.synth(ctx, d) },
  footstep_wood_3: { category: 'sfx', volume: 0.28, polyphonic: true,
    synth: (ctx, d) => SOUNDS.footstep_wood_1.synth(ctx, d) },

  // ── Landing variant ──
  land_2:        { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => SOUNDS.land.synth(ctx, d) },

  // ── Death & grunt sounds ──
  death:         { category: 'sfx', volume: 0.6, polyphonic: true,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, t);
      osc.frequency.exponentialRampToValueAtTime(60, t + 0.4);
      const g = ctx.createGain();
      envelope(g, t, 0.005, 0.35, 0.5);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.42);
      return 0.42;
    },
  },
  grunt_1:       { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => SOUNDS.hit_taken.synth(ctx, d) },
  grunt_2:       { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => SOUNDS.hit_taken.synth(ctx, d) },
  grunt_3:       { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => SOUNDS.hit_taken.synth(ctx, d) },

  // ── Respawn ──
  respawn:       { category: 'sfx', volume: 0.5,
    synth: (ctx, d) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(330, t);
      osc.frequency.linearRampToValueAtTime(660, t + 0.2);
      const g = ctx.createGain();
      envelope(g, t, 0.01, 0.3, 0.4);
      osc.connect(g).connect(d);
      osc.start(t); osc.stop(t + 0.35);
      return 0.35;
    },
  },

  // ── Impact variants (surface types) ──
  impact_body_2:     { category: 'sfx', volume: 0.5, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_body.synth(ctx, d) },
  impact_body_3:     { category: 'sfx', volume: 0.5, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_body.synth(ctx, d) },
  impact_wall_2:     { category: 'sfx', volume: 0.4, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_metal:      { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_iron:       { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_iron_light: { category: 'sfx', volume: 0.35, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_wood_1:     { category: 'sfx', volume: 0.4, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_wood_2:     { category: 'sfx', volume: 0.4, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_rock_1:     { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_rock_2:     { category: 'sfx', volume: 0.45, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_gravel_1:   { category: 'sfx', volume: 0.35, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  impact_gravel_2:   { category: 'sfx', volume: 0.35, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_wall.synth(ctx, d) },
  death_impact:      { category: 'sfx', volume: 0.6, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_body.synth(ctx, d) },
  result_impact:     { category: 'sfx', volume: 0.5, polyphonic: true,
    synth: (ctx, d) => SOUNDS.impact_body.synth(ctx, d) },

  // ── Extra weapon mechanical sounds ──
  sniper_load:       { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => SOUNDS.weapon_swap.synth(ctx, d) },
  scar_mag_load:     { category: 'sfx', volume: 0.45,
    synth: (ctx, d) => SOUNDS.weapon_swap.synth(ctx, d) },
  scar_tail:         { category: 'sfx', volume: 0.3, polyphonic: true,
    synth: (ctx, d) => { return 0; } },
  scar_tail_fire:    { category: 'sfx', volume: 0.3, polyphonic: true,
    synth: (ctx, d) => { return 0; } },
  tec9_tail:         { category: 'sfx', volume: 0.3, polyphonic: true,
    synth: (ctx, d) => { return 0; } },
  tec9_tail_fire:    { category: 'sfx', volume: 0.3, polyphonic: true,
    synth: (ctx, d) => { return 0; } },
  tec9_load:         { category: 'sfx', volume: 0.4,
    synth: (ctx, d) => SOUNDS.weapon_swap.synth(ctx, d) },
  tec9_unload:       { category: 'sfx', volume: 0.4,
    synth: (ctx, d) => SOUNDS.weapon_swap.synth(ctx, d) },
};

/**
 * Real asset URLs. Files live in /public/audio/<path>.
 * They automatically replace the synth fallbacks.
 */
export const REAL_SOUND_URLS: Record<string, string> = {
  // ── Weapons: fire ──
  shot_pistol:       'weapons/pistol-fire.mp3',
  shot_smg:          'weapons/tec-9-fire.mp3',
  shot_ar:           'weapons/m4-fire.mp3',
  shot_shotgun:      'weapons/shotgun-fire.mp3',
  shot_sniper:       'weapons/sniper-fire.mp3',
  shot_rocket:       'weapons/grenade-launcher.mp3',
  shot_ak47:         'weapons/ak47-fire.mp3',
  shot_awp:          'weapons/awp-fire.mp3',
  shot_scar:         'weapons/scar-fire-1.mp3',
  shot_lmg:          'weapons/lmg-fire.mp3',

  // ── Weapons: reload / mechanical ──
  reload:            'weapons/scar-reload.mp3',
  reload_pistol:     'weapons/pistol-reload.mp3',
  reload_smg:        'weapons/tec-9-reload.mp3',
  load_smg:          'weapons/tec-9-load.mp3',
  reload_ar:         'weapons/scar-reload.mp3',
  load_ar:           'weapons/scar-magazine-load.mp3',
  reload_shotgun:    'weapons/shotgun-load.mp3',
  cock_shotgun:      'weapons/shotgun-cock.mp3',
  reload_sniper:     'weapons/sniper-reload.mp3',
  load_sniper:       'weapons/sniper-load.mp3',
  reload_rocket:     'weapons/rocket-reload.mp3',
  reload_lmg:        'weapons/lmg-reload.mp3',
  weapon_swap:       'weapons/scar-magazine-click.mp3',
  empty_click:       'weapons/empty_click.mp3',
  shotgun_cock:      'weapons/shotgun-cock.mp3',
  sniper_zoom:       'weapons/sniper-zoom.mp3',
  sniper_load:       'weapons/sniper-load.mp3',
  scar_mag_load:     'weapons/scar-magazine-load.mp3',
  scar_tail:         'weapons/scar-tail.mp3',
  scar_tail_fire:    'weapons/scar-tail-fire.mp3',
  tec9_tail:         'weapons/tec-9-tail.mp3',
  tec9_tail_fire:    'weapons/tec-9-tail-fire.mp3',
  tec9_load:         'weapons/tec-9-load.mp3',
  tec9_unload:       'weapons/tec-9-unload.mp3',

  // ── Explosions ──
  explosion:         'weapons/grenade-explosion.mp3',

  // ── Impacts ──
  impact_body:       'impact/body-impact-1.mp3',
  impact_body_2:     'impact/body-impact-2.mp3',
  impact_body_3:     'impact/body-impact-3.mp3',
  impact_headshot:   'impact/hit-impact.mp3',
  impact_wall:       'impact/impact-brick-1.mp3',
  impact_wall_2:     'impact/impact-brick-2.mp3',
  impact_metal:      'impact/impact-metal.mp3',
  impact_iron:       'impact/impact-iron.mp3',
  impact_iron_light: 'impact/impact-iron-light.mp3',
  impact_wood_1:     'impact/impact-wood-1.mp3',
  impact_wood_2:     'impact/impact-wood-2.mp3',
  impact_rock_1:     'impact/impact-rock-1.mp3',
  impact_rock_2:     'impact/impact-rock-2.mp3',
  impact_gravel_1:   'impact/impact-gravel-1.mp3',
  impact_gravel_2:   'impact/impact-gravel-2.mp3',
  death_impact:      'impact/death-impact.mp3',
  result_impact:     'impact/result-impact.mp3',

  // ── Player: footsteps ──
  footstep:          'player/concrete-run-1.mp3',
  footstep_1:        'player/concrete-run-1.mp3',
  footstep_2:        'player/concrete-run-2.mp3',
  footstep_3:        'player/concrete-run-3.mp3',
  footstep_4:        'player/concrete-run-4.mp3',
  footstep_5:        'player/concrete-run-5.mp3',
  footstep_6:        'player/concrete-run-6.mp3',

  // ── Player: surface footsteps ──
  footstep_metal_1:  'player/metal-run-1.mp3',
  footstep_metal_2:  'player/metal-run-2.mp3',
  footstep_metal_3:  'player/metal-run-3.mp3',
  footstep_wood_1:   'player/wood-run-1.mp3',
  footstep_wood_2:   'player/wood-run-2.mp3',
  footstep_wood_3:   'player/wood-run-3.mp3',

  // ── Player: movement ──
  jump:              'player/jump.mp3',
  land:              'player/land-1.mp3',
  land_2:            'player/land-2.mp3',
  slide:             'player/slide.mp3',

  // ── Player: voice / body ──
  hit_taken:         'player/echo-grunt-1.mp3',
  grunt_1:           'player/echo-grunt-1.mp3',
  grunt_2:           'player/echo-grunt-2.mp3',
  grunt_3:           'player/echo-grunt-3.mp3',
  death:             'player/echo-death-1.mp3',
  heartbeat:         'player/heart-beat.mp3',

  // ── Level / game events ──
  heal:              'level/health-regen.mp3',
  pickup:            'level/potion-pickup.mp3',
  respawn:           'level/respawn-sound.mp3',

  // ── UI ──
  ui_hover:          'ui/ui_hover.mp3',
  ui_confirm:        'ui/ui_confirm.mp3',
  ui_deny:           'ui/ui_deny.mp3',

  // ── Announcer ──
  medal_silver:           'announcer/double_kill.mp3',
  medal_gold:             'announcer/medal_gold.mp3',
  medal_epic:             'announcer/unstopable.mp3',
  victory:                'announcer/victory.mp3',
  defeat:                 'announcer/defeat.mp3',
  announcer_tdm:          'announcer/warzone.mp3',
  announcer_eliminate:    'announcer/eliminate_all_hostile_forces.mp3',
  announcer_enemy_ahead:  'announcer/enemy_is_polling_ahead.mp3',
  announcer_fight_back:   'announcer/fight_back.mp3',
  announcer_finish_them:  'announcer/finish_them.mp3',
  announcer_halfway:      'announcer/halfway_to_victory.mp3',
  announcer_pressure:     'announcer/keep_the_pressure_on.mp3',
  announcer_1min:         'announcer/one_minute_remaining.mp3',
  announcer_secure:       'announcer/secure_the_arena.mp3',
  announcer_10sec:        'announcer/ten_seconds.mp3',
  announcer_green:        'announcer/we_are_green_to_go.mp3',
  announcer_in_lead:      'announcer/we_are_in_the_lead.mp3',
  announcer_lost_lead:    'announcer/we_have_lost_the_lead.mp3',
  announcer_taken_lead:   'announcer/we_have_taken_the_lead.mp3',
  announcer_double_kill:  'announcer/double_kill.mp3',
  announcer_triple_kill:  'announcer/tripple_kill.mp3',
  announcer_overkill:     'announcer/overkill.mp3',
  announcer_bloodthirsty: 'announcer/bloodthirsty.mp3',
  announcer_unstoppable:  'announcer/unstoppable.mp3',
  announcer_godlike:      'announcer/god_like.mp3',
  mission_accomplished:   'announcer/mission_accomplished.mp3',
  outstanding_work:       'announcer/outstanding_work_out_there.mp3',
  mission_failed:         'announcer/mission_failed.mp3',
  returning_to_base:      'announcer/returning_to_base.mp3',
  stand_down:             'announcer/stand_down.mp3',
  get_them_next_time:     'announcer/we_will_get_them_next_time.mp3',

  // ── Music ──
  music_lobby:       'music/music_lobby.mp3',
  music_start:       'music/music_start.mp3',
  music_midmatch:    'music/music_midmatch.mp3',
  music_climax:      'music/music_climax.mp3',
  music_victory:     'music/music_victory.mp3',
  music_defeat:      'music/music_defeat.mp3',
};
