/**
 * DynamicWeather — mid-match transitions between weather presets.
 *
 * Problem: existing Lights.ts rolls a random weather preset at scene reset.
 * Players never see weather change. Missed atmospheric opportunity.
 *
 * Solution: probabilistic mid-match weather shifts with smooth multi-channel
 * interpolation (fog density/color, ambient intensity, directional color,
 * sky tint, precipitation intensity).
 *
 * Shift types:
 *   - Storm rolling in: clear → overcast → storm → rain
 *   - Storm clearing: rain → overcast → clear
 *   - Fog descending: clear → fog
 *   - Dawn → noon → dusk → night (time-of-day)
 *
 * Transitions take 30-60 seconds so they feel natural. One transition per
 * match typical, two maximum.
 *
 * Particle systems (rain, snow, dust) drive off a single `precipitation`
 * channel that can smoothly crossfade types.
 *
 * Integration:
 *   - initDynamicWeather(scene, renderer) once at match start
 *   - updateDynamicWeather(dt) from GameLoop
 *   - readWeatherState() for UI / sound (rain audio volume tracks intensity)
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';

export type WeatherPreset = 'clear' | 'overcast' | 'storm' | 'tempest' | 'rain' | 'fog' | 'snow' | 'dusk' | 'night' | 'dawn';

interface WeatherChannels {
  skyTop: THREE.Color;
  skyBottom: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  sunAngle: number;         // radians above horizon (0 = sunset, pi/2 = noon)
  rainIntensity: number;    // 0-1
  snowIntensity: number;    // 0-1
  windSpeed: number;        // m/s
  lightningChancePerSec: number;
}

const PRESETS: Record<WeatherPreset, WeatherChannels> = {
  // "Clear" is the baseline but moodier — this is a combat map, not a
  // holiday brochure. Deep cobalt sky, desaturated sun.
  clear: {
    skyTop: new THREE.Color(0x1b3560), skyBottom: new THREE.Color(0x5c85b8),
    fogColor: new THREE.Color(0x7088a8), fogDensity: 0.006,
    ambientColor: new THREE.Color(0xb8c4d8), ambientIntensity: 0.4,
    sunColor: new THREE.Color(0xffd8aa), sunIntensity: 1.15,
    sunAngle: 1.1, rainIntensity: 0, snowIntensity: 0,
    windSpeed: 2.5, lightningChancePerSec: 0,
  },
  // Ominous overcast — gunmetal, heavy, no sun bleed.
  overcast: {
    skyTop: new THREE.Color(0x2a323c), skyBottom: new THREE.Color(0x4c5663),
    fogColor: new THREE.Color(0x545c68), fogDensity: 0.014,
    ambientColor: new THREE.Color(0x606878), ambientIntensity: 0.5,
    sunColor: new THREE.Color(0x6a7280), sunIntensity: 0.25,
    sunAngle: 0.9, rainIntensity: 0, snowIntensity: 0,
    windSpeed: 7, lightningChancePerSec: 0,
  },
  // Heavy storm — near-black clouds, frequent lightning, driving rain.
  storm: {
    skyTop: new THREE.Color(0x0a0c14), skyBottom: new THREE.Color(0x252a38),
    fogColor: new THREE.Color(0x1e2230), fogDensity: 0.032,
    ambientColor: new THREE.Color(0x353c4c), ambientIntensity: 0.3,
    sunColor: new THREE.Color(0x40485a), sunIntensity: 0.1,
    sunAngle: 0.8, rainIntensity: 1.0, snowIntensity: 0,
    windSpeed: 18, lightningChancePerSec: 0.28,
  },
  // Tempest — full chaos. Near-pitch sky, constant lightning, torrential
  // rain, howling wind. Climactic mid-match shift target.
  tempest: {
    skyTop: new THREE.Color(0x05060a), skyBottom: new THREE.Color(0x14182a),
    fogColor: new THREE.Color(0x10142a), fogDensity: 0.045,
    ambientColor: new THREE.Color(0x2a3048), ambientIntensity: 0.22,
    sunColor: new THREE.Color(0x2a324a), sunIntensity: 0.05,
    sunAngle: 0.75, rainIntensity: 1.0, snowIntensity: 0,
    windSpeed: 26, lightningChancePerSec: 0.55,
  },
  // Steady rain, low visibility, occasional lightning.
  rain: {
    skyTop: new THREE.Color(0x20283a), skyBottom: new THREE.Color(0x45515e),
    fogColor: new THREE.Color(0x3a4250), fogDensity: 0.02,
    ambientColor: new THREE.Color(0x606878), ambientIntensity: 0.4,
    sunColor: new THREE.Color(0x606a80), sunIntensity: 0.2,
    sunAngle: 0.85, rainIntensity: 0.75, snowIntensity: 0,
    windSpeed: 10, lightningChancePerSec: 0.06,
  },
  // Thick, claustrophobic fog — visibility is the gameplay twist.
  fog: {
    skyTop: new THREE.Color(0x50555c), skyBottom: new THREE.Color(0x6a6e76),
    fogColor: new THREE.Color(0x62666e), fogDensity: 0.075,
    ambientColor: new THREE.Color(0x787e88), ambientIntensity: 0.55,
    sunColor: new THREE.Color(0x808088), sunIntensity: 0.25,
    sunAngle: 0.7, rainIntensity: 0, snowIntensity: 0,
    windSpeed: 1.5, lightningChancePerSec: 0,
  },
  // Cold, bitter snow — wind-driven, darker than the stereotype.
  snow: {
    skyTop: new THREE.Color(0x2e3642), skyBottom: new THREE.Color(0x6a7582),
    fogColor: new THREE.Color(0x5c6572), fogDensity: 0.022,
    ambientColor: new THREE.Color(0x8892a0), ambientIntensity: 0.55,
    sunColor: new THREE.Color(0xb8c0d0), sunIntensity: 0.5,
    sunAngle: 0.6, rainIntensity: 0, snowIntensity: 0.9,
    windSpeed: 9, lightningChancePerSec: 0,
  },
  // Blood-orange dusk against deep violet — dramatic and hot.
  dusk: {
    skyTop: new THREE.Color(0x140824), skyBottom: new THREE.Color(0xb83a18),
    fogColor: new THREE.Color(0x7a2a15), fogDensity: 0.014,
    ambientColor: new THREE.Color(0xa04028), ambientIntensity: 0.32,
    sunColor: new THREE.Color(0xff3a10), sunIntensity: 1.3,
    sunAngle: 0.08, rainIntensity: 0, snowIntensity: 0,
    windSpeed: 3, lightningChancePerSec: 0,
  },
  // Deep night — visibility hostile, rim of moonlight only.
  night: {
    skyTop: new THREE.Color(0x010205), skyBottom: new THREE.Color(0x070a16),
    fogColor: new THREE.Color(0x04060e), fogDensity: 0.028,
    ambientColor: new THREE.Color(0x1e2438), ambientIntensity: 0.22,
    sunColor: new THREE.Color(0x3a4880), sunIntensity: 0.12, // "moon"
    sunAngle: 1.2, rainIntensity: 0, snowIntensity: 0,
    windSpeed: 2, lightningChancePerSec: 0,
  },
  // Hard, cold dawn — rust vs cobalt, sun low on the horizon.
  dawn: {
    skyTop: new THREE.Color(0x181032), skyBottom: new THREE.Color(0xc04820),
    fogColor: new THREE.Color(0x8a3820), fogDensity: 0.016,
    ambientColor: new THREE.Color(0xa05030), ambientIntensity: 0.38,
    sunColor: new THREE.Color(0xff4818), sunIntensity: 1.1,
    sunAngle: 0.15, rainIntensity: 0, snowIntensity: 0,
    windSpeed: 2.5, lightningChancePerSec: 0,
  },
};

// Plausible transitions (directed graph). Biased toward darker states —
// clear is a departure lounge that funnels you into storm fronts fast.
const TRANSITIONS: Record<WeatherPreset, WeatherPreset[]> = {
  clear: ['overcast', 'overcast', 'dusk', 'fog'],
  overcast: ['storm', 'storm', 'rain', 'tempest', 'fog'],
  storm: ['tempest', 'tempest', 'rain', 'overcast'],
  tempest: ['storm', 'rain'],
  rain: ['storm', 'tempest', 'overcast'],
  fog: ['overcast', 'storm'],
  snow: ['storm', 'overcast'],
  dusk: ['night', 'night', 'storm'],
  night: ['storm', 'tempest', 'dawn'],
  dawn: ['overcast', 'storm'],
};

// ─────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────

interface DynamicWeatherState {
  scene: THREE.Scene | null;
  currentPreset: WeatherPreset;
  targetPreset: WeatherPreset;
  current: WeatherChannels;
  origin: WeatherChannels;
  target: WeatherChannels;
  transitionT: number;       // 0-1
  transitionDuration: number; // seconds
  transitioning: boolean;
  matchElapsed: number;
  nextShiftAttempt: number;  // seconds
  transitionsThisMatch: number;

  fog: THREE.FogExp2 | null;
  ambient: THREE.AmbientLight | null;
  sun: THREE.DirectionalLight | null;

  rainSystem: RainSystem | null;
  snowSystem: SnowSystem | null;
  skyDome: SkyDome | null;
  lightningCooldown: number;
}

const state: DynamicWeatherState = {
  scene: null,
  currentPreset: 'clear',
  targetPreset: 'clear',
  current: cloneChannels(PRESETS.clear),
  origin: cloneChannels(PRESETS.clear),
  target: cloneChannels(PRESETS.clear),
  transitionT: 0,
  transitionDuration: 0,
  transitioning: false,
  matchElapsed: 0,
  nextShiftAttempt: 20, // first shift possible after 20s — weather must feel alive early
  transitionsThisMatch: 0,
  fog: null,
  ambient: null,
  sun: null,
  rainSystem: null,
  snowSystem: null,
  skyDome: null,
  lightningCooldown: 0,
};

function cloneChannels(c: WeatherChannels): WeatherChannels {
  return {
    skyTop: c.skyTop.clone(),
    skyBottom: c.skyBottom.clone(),
    fogColor: c.fogColor.clone(),
    fogDensity: c.fogDensity,
    ambientColor: c.ambientColor.clone(),
    ambientIntensity: c.ambientIntensity,
    sunColor: c.sunColor.clone(),
    sunIntensity: c.sunIntensity,
    sunAngle: c.sunAngle,
    rainIntensity: c.rainIntensity,
    snowIntensity: c.snowIntensity,
    windSpeed: c.windSpeed,
    lightningChancePerSec: c.lightningChancePerSec,
  };
}

function lerpChannels(out: WeatherChannels, a: WeatherChannels, b: WeatherChannels, t: number): void {
  const te = easeInOut(t);
  out.skyTop.lerpColors(a.skyTop, b.skyTop, te);
  out.skyBottom.lerpColors(a.skyBottom, b.skyBottom, te);
  out.fogColor.lerpColors(a.fogColor, b.fogColor, te);
  out.fogDensity = lerp(a.fogDensity, b.fogDensity, te);
  out.ambientColor.lerpColors(a.ambientColor, b.ambientColor, te);
  out.ambientIntensity = lerp(a.ambientIntensity, b.ambientIntensity, te);
  out.sunColor.lerpColors(a.sunColor, b.sunColor, te);
  out.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, te);
  out.sunAngle = lerp(a.sunAngle, b.sunAngle, te);
  out.rainIntensity = lerp(a.rainIntensity, b.rainIntensity, te);
  out.snowIntensity = lerp(a.snowIntensity, b.snowIntensity, te);
  out.windSpeed = lerp(a.windSpeed, b.windSpeed, te);
  out.lightningChancePerSec = lerp(a.lightningChancePerSec, b.lightningChancePerSec, te);
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function easeInOut(t: number): number { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

// ─────────────────────────────────────────────────────────────────────
//  PRECIPITATION SYSTEMS
// ─────────────────────────────────────────────────────────────────────

class RainSystem {
  public mesh: THREE.Points;
  private velocities: Float32Array;
  private count: number;
  private radius: number;
  private intensity: number = 0;

  constructor(scene: THREE.Scene, count: number = 1500, radius: number = 80) {
    this.count = count;
    this.radius = radius;
    const positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * radius * 2;
      positions[i * 3 + 1] = Math.random() * 60;
      positions[i * 3 + 2] = (Math.random() - 0.5) * radius * 2;
      this.velocities[i * 3 + 0] = -2;
      this.velocities[i * 3 + 1] = -45;
      this.velocities[i * 3 + 2] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xaabbcc, size: 0.08, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Points(geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(dt: number, intensity: number, windSpeed: number, cameraPos: THREE.Vector3): void {
    this.intensity = intensity;
    const mat = this.mesh.material as THREE.PointsMaterial;
    mat.opacity = intensity * 0.45;
    this.mesh.visible = intensity > 0.02;
    if (!this.mesh.visible) return;

    const posAttr = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      arr[ix + 0] += this.velocities[ix + 0] * dt + windSpeed * dt * 0.3;
      arr[ix + 1] += this.velocities[ix + 1] * dt * (0.5 + intensity);
      // Respawn when below ground or too far
      if (arr[ix + 1] < 0) {
        arr[ix + 0] = cameraPos.x + (Math.random() - 0.5) * this.radius * 2;
        arr[ix + 1] = cameraPos.y + 40 + Math.random() * 20;
        arr[ix + 2] = cameraPos.z + (Math.random() - 0.5) * this.radius * 2;
      }
    }
    posAttr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

class SnowSystem {
  public mesh: THREE.Points;
  private velocities: Float32Array;
  private count: number;
  private radius: number;
  private phases: Float32Array;

  constructor(scene: THREE.Scene, count: number = 1200, radius: number = 65) {
    this.count = count;
    this.radius = radius;
    const positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * radius * 2;
      positions[i * 3 + 1] = Math.random() * 50;
      positions[i * 3 + 2] = (Math.random() - 0.5) * radius * 2;
      this.velocities[i * 3 + 1] = -1.2 - Math.random() * 0.5;
      this.phases[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.18, transparent: true, opacity: 0, depthWrite: false,
    });
    this.mesh = new THREE.Points(geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(dt: number, intensity: number, windSpeed: number, cameraPos: THREE.Vector3, elapsed: number): void {
    const mat = this.mesh.material as THREE.PointsMaterial;
    mat.opacity = intensity * 0.7;
    this.mesh.visible = intensity > 0.02;
    if (!this.mesh.visible) return;

    const posAttr = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      arr[ix + 0] += Math.sin(elapsed + this.phases[i]) * dt * 0.4 + windSpeed * dt * 0.15;
      arr[ix + 1] += this.velocities[ix + 1] * dt;
      arr[ix + 2] += Math.cos(elapsed + this.phases[i]) * dt * 0.4;
      if (arr[ix + 1] < 0) {
        arr[ix + 0] = cameraPos.x + (Math.random() - 0.5) * this.radius * 2;
        arr[ix + 1] = cameraPos.y + 30 + Math.random() * 20;
        arr[ix + 2] = cameraPos.z + (Math.random() - 0.5) * this.radius * 2;
      }
    }
    posAttr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────
//  SKY DOME SHADER
// ─────────────────────────────────────────────────────────────────────
//
// Single inverted sphere centered on the camera each frame.  ShaderMaterial
// does a vertical gradient between skyTop/skyBottom, a procedural 2-octave
// value-noise cloud layer whose coverage is driven by a `cloudiness` value
// (derived from fog density), and a cheap sun disc + halo.  No textures,
// no post-processing, one extra draw call — fragment cost is a handful of
// ALU ops per pixel, well under 0.1 ms on modern GPUs at 1080p.

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyBottom;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  uniform float uCloudiness;
  uniform float uTime;
  uniform float uWind;
  varying vec3 vDir;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 sky = mix(uSkyBottom, uSkyTop, pow(h, 0.55));

    // Sun / moon disc + halo, only when source is above the horizon.
    if (uSunDir.y > -0.15) {
      float sd = max(dot(dir, normalize(uSunDir)), 0.0);
      float disc = smoothstep(0.9985, 0.9997, sd);
      float halo = pow(sd, 48.0) * 0.55 + pow(sd, 8.0) * 0.08;
      float cloudMask = 1.0 - uCloudiness * 0.75;
      sky += uSunColor * (disc * 1.6 + halo) * uSunIntensity * cloudMask;
    }

    // Cheap clouds: planar projection of upper hemisphere, 2 octaves.
    if (uCloudiness > 0.01 && dir.y > 0.02) {
      vec2 uv = dir.xz / max(dir.y, 0.12);
      uv *= 0.18;
      uv.x += uTime * (0.002 + uWind * 0.006);
      uv.y += uTime * (0.001 + uWind * 0.002);
      float n = noise(uv) * 0.58 + noise(uv * 2.3 + 7.1) * 0.32 + noise(uv * 5.1 + 3.7) * 0.10;
      // Coverage ramps hard — almost 0 at uCloudiness=0.2, fully saturated
      // by 0.9, so storms feel like a wall of clouds instead of wisps.
      float cov = smoothstep(0.60 - uCloudiness * 0.55, 0.78 - uCloudiness * 0.15, n);
      float edge = smoothstep(0.0, 0.18, dir.y);
      // Cloud color gets darker and more saturated as cloudiness rises —
      // thunderheads are nearly black at the base with a slight rim from
      // the sky dome tint.
      vec3 cloudDark = uSkyTop * 0.35;
      vec3 cloudLight = mix(uSkyBottom * 0.8, vec3(1.0) * length(uSkyBottom) * 0.55, 1.0 - uCloudiness);
      vec3 cloudCol = mix(cloudLight, cloudDark, uCloudiness);
      sky = mix(sky, cloudCol, cov * edge * (0.6 + uCloudiness * 0.4));
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

class SkyDome {
  public mesh: THREE.Mesh;
  public material: THREE.ShaderMaterial;
  private camera: THREE.Camera;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.camera = camera;
    const geo = new THREE.SphereGeometry(200, 24, 16);
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uSkyTop: { value: new THREE.Color(0x4a90ff) },
        uSkyBottom: { value: new THREE.Color(0xbfe0ff) },
        uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.2) },
        uSunColor: { value: new THREE.Color(0xffeedd) },
        uSunIntensity: { value: 1.0 },
        uCloudiness: { value: 0.0 },
        uTime: { value: 0.0 },
        uWind: { value: 1.5 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.onBeforeRender = () => {
      this.mesh.position.copy((this.camera as THREE.PerspectiveCamera).position);
    };
    scene.add(this.mesh);
  }

  updateFromChannels(c: WeatherChannels, dt: number): void {
    const u = this.material.uniforms;
    u.uSkyTop.value.copy(c.skyTop);
    u.uSkyBottom.value.copy(c.skyBottom);
    u.uSunColor.value.copy(c.sunColor);
    u.uSunIntensity.value = c.sunIntensity;
    // Derive cloudiness from fog density, but cap before the "fog" preset
    // (fogDensity ≈ 0.075 is ground mist, not overhead cloud cover). Map
    // 0.005–0.045 → 0–1 so overcast/storm/tempest fill the sky properly.
    const raw = THREE.MathUtils.smoothstep(c.fogDensity, 0.005, 0.045);
    // If fogDensity is way past tempest, assume ground fog and fade clouds out.
    const fogFade = 1.0 - THREE.MathUtils.smoothstep(c.fogDensity, 0.05, 0.08);
    u.uCloudiness.value = raw * fogFade;
    u.uWind.value = c.windSpeed;
    u.uTime.value += dt;
    // Sun direction: reuse the same orbit as applyCurrentToScene.
    const sx = Math.cos(c.sunAngle) * 0.6;
    const sy = Math.sin(c.sunAngle);
    const sz = Math.sin(c.sunAngle * 0.7) * 0.4;
    u.uSunDir.value.set(sx, sy, sz).normalize();
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────
//  LIGHTNING FLASH
// ─────────────────────────────────────────────────────────────────────

let lightningFlashEl: HTMLDivElement | null = null;

function ensureLightningOverlay(): HTMLDivElement {
  if (lightningFlashEl) return lightningFlashEl;
  lightningFlashEl = document.createElement('div');
  lightningFlashEl.id = 'lightningFlash';
  document.body.appendChild(lightningFlashEl);
  const s = document.createElement('style');
  s.textContent = `
    #lightningFlash {
      position: fixed; inset: 0;
      background: white;
      opacity: 0; pointer-events: none;
      z-index: 8;
      mix-blend-mode: screen;
    }
    #lightningFlash.flash {
      animation: lightningFlash 0.7s ease-out;
    }
    @keyframes lightningFlash {
      0% { opacity: 0; }
      4% { opacity: 0.85; }
      8% { opacity: 0.2; }
      14% { opacity: 0.7; }
      20% { opacity: 0; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(s);
  return lightningFlashEl;
}

function triggerLightning(): void {
  const el = ensureLightningOverlay();
  el.classList.remove('flash');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('flash');

  // Delayed thunder sound
  const thunderDelay = 600 + Math.random() * 1600;
  setTimeout(() => {
    import('@/audio/SoundHooks').then(s => {
      try { (s as any).playThunder?.() ?? (s as any).playExplosion?.(); } catch { /* */ }
    }).catch(() => { /* */ });
  }, thunderDelay);

  // Momentary sun intensity spike
  if (state.sun) {
    const baseI = state.sun.intensity;
    state.sun.intensity = baseI + 2.5;
    setTimeout(() => { if (state.sun) state.sun.intensity = baseI; }, 60);
    setTimeout(() => { if (state.sun) state.sun.intensity = baseI + 1.8; }, 160);
    setTimeout(() => { if (state.sun) state.sun.intensity = baseI; }, 220);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  MAIN LIFECYCLE
// ─────────────────────────────────────────────────────────────────────

export function initDynamicWeather(
  scene: THREE.Scene,
  ambient: THREE.AmbientLight,
  sun: THREE.DirectionalLight,
  camera: THREE.Camera | null = null,
  initialPreset: WeatherPreset = 'clear',
): void {
  // Clean up any existing weather systems before re-initializing
  disposeDynamicWeather();

  state.scene = scene;
  state.ambient = ambient;
  state.sun = sun;

  // Ensure scene has exponential fog
  if (!(scene.fog instanceof THREE.FogExp2)) {
    scene.fog = new THREE.FogExp2(0xd0e5ff, 0.0025);
  }
  state.fog = scene.fog as THREE.FogExp2;

  state.currentPreset = initialPreset;
  state.targetPreset = initialPreset;
  state.current = cloneChannels(PRESETS[initialPreset]);
  state.origin = cloneChannels(PRESETS[initialPreset]);
  state.target = cloneChannels(PRESETS[initialPreset]);

  // Create precipitation systems
  state.rainSystem = new RainSystem(scene);
  state.snowSystem = new SnowSystem(scene);

  // Procedural sky dome (shader-driven, GPU-cheap). Falls back to a solid
  // scene.background only if no camera was provided.
  if (camera) {
    state.skyDome = new SkyDome(scene, camera);
    scene.background = null;
  } else {
    (scene.background as any) = state.current.skyBottom.clone();
  }

  applyCurrentToScene();
}

function applyCurrentToScene(): void {
  const c = state.current;
  if (state.fog) {
    state.fog.color.copy(c.fogColor);
    state.fog.density = c.fogDensity;
  }
  if (state.ambient) {
    state.ambient.color.copy(c.ambientColor);
    state.ambient.intensity = c.ambientIntensity;
  }
  if (state.sun) {
    state.sun.color.copy(c.sunColor);
    state.sun.intensity = c.sunIntensity;
    // Position sun based on angle (simplified: orbit in XZ from a fixed horizon)
    const dist = 100;
    state.sun.position.set(
      Math.cos(c.sunAngle) * dist * 0.6,
      Math.sin(c.sunAngle) * dist,
      Math.sin(c.sunAngle * 0.7) * dist * 0.4,
    );
  }
  if (state.scene?.background instanceof THREE.Color) {
    state.scene.background.copy(c.skyBottom);
  }
  // Sky-dome uniforms are updated from updateDynamicWeather each frame so
  // time/wind continue to animate even when no transition is active; we
  // still push channel-driven values here so the first frame is correct.
  state.skyDome?.updateFromChannels(state.current, 0);
}

/**
 * Force a transition to the given preset.
 */
export function transitionTo(preset: WeatherPreset, durationSec: number = 35): void {
  if (preset === state.currentPreset && !state.transitioning) return;
  state.origin = cloneChannels(state.current);
  state.target = cloneChannels(PRESETS[preset]);
  state.targetPreset = preset;
  state.transitionT = 0;
  state.transitionDuration = durationSec;
  state.transitioning = true;
  state.transitionsThisMatch++;

  import('@/ui/Announcer').then(a => {
    a.announce(`WEATHER SHIFT`, {
      sub: preset.toUpperCase(),
      tier: 'small',
      color: '#8ab4f0',
      duration: 2,
    });
  }).catch(() => { /* */ });
}

/**
 * Try to trigger a random mid-match shift. Probabilistic.
 *
 * Tuned aggressive for action intensity: 60% trigger rate at each attempt,
 * up to 4 shifts per match, faster transitions (12–28 s) so the sky
 * visibly changes during a single firefight.
 */
function attemptShift(): void {
  if (state.transitioning) return;
  if (state.transitionsThisMatch >= 4) return;

  const possibleTargets = TRANSITIONS[state.currentPreset] ?? [];
  if (possibleTargets.length === 0) return;

  if (Math.random() > 0.6) {
    state.nextShiftAttempt = state.matchElapsed + 35;
    return;
  }

  const next = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
  const duration = 12 + Math.random() * 16;
  transitionTo(next, duration);
  state.nextShiftAttempt = state.matchElapsed + duration + 18 + Math.random() * 25;
}

let _precipFrame = 0;

export function updateDynamicWeather(dt: number, cameraPos?: THREE.Vector3): void {
  state.matchElapsed += dt;

  // Transition stepping
  if (state.transitioning) {
    state.transitionT += dt / state.transitionDuration;
    if (state.transitionT >= 1) {
      state.transitionT = 1;
      state.current = cloneChannels(state.target);
      state.currentPreset = state.targetPreset;
      state.transitioning = false;
    } else {
      lerpChannels(state.current, state.origin, state.target, state.transitionT);
    }
    applyCurrentToScene();
  }

  // Shift attempts
  if (state.matchElapsed >= state.nextShiftAttempt) {
    attemptShift();
  }

  // Sky dome: advance time/wind every frame so clouds drift even when
  // no transition is in progress.
  state.skyDome?.updateFromChannels(state.current, dt);

  // Precipitation — throttle to every 2nd frame and skip entirely
  // during heavy combat (player can't notice rain fidelity in a firefight).
  _precipFrame++;
  const skipPrecip = (_precipFrame & 1) === 0;
  const combatHeavy = gameState.particles?.length > 100;
  const camPos = cameraPos ?? new THREE.Vector3();
  if (state.rainSystem && !skipPrecip && !combatHeavy) {
    state.rainSystem.update(dt * 2, state.current.rainIntensity, state.current.windSpeed, camPos);
  }
  if (state.snowSystem && !skipPrecip && !combatHeavy) {
    state.snowSystem.update(dt * 2, state.current.snowIntensity, state.current.windSpeed, camPos, state.matchElapsed);
  }

  // Lightning
  state.lightningCooldown -= dt;
  if (state.current.lightningChancePerSec > 0 && state.lightningCooldown <= 0) {
    if (Math.random() < state.current.lightningChancePerSec * dt * 2) {
      triggerLightning();
      state.lightningCooldown = 2 + Math.random() * 5;
    }
  }
}

export function readWeatherState(): Readonly<WeatherChannels> & { preset: WeatherPreset; transitioning: boolean } {
  return {
    ...state.current,
    preset: state.currentPreset,
    transitioning: state.transitioning,
  };
}

export function resetDynamicWeather(): void {
  state.matchElapsed = 0;
  state.nextShiftAttempt = 20;
  state.transitionsThisMatch = 0;
  state.transitioning = false;
  state.transitionT = 0;
}

export function disposeDynamicWeather(): void {
  state.rainSystem?.dispose();
  state.snowSystem?.dispose();
  state.skyDome?.dispose();
  state.rainSystem = null;
  state.snowSystem = null;
  state.skyDome = null;
}