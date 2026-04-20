import * as THREE from 'three';
import { gameState } from '@/core/GameState';

/**
 * AAA-style lighting: bright key sun, cool ambient fill, warm rim on team bases,
 * visible but atmospheric. Scene is readable during combat.
 */

// ── Weather presets ──
interface WeatherPreset {
  name: string;
  sunColor: number; sunIntensity: number;
  ambientColor: number; ambientIntensity: number;
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  fogColor: number; fogDensity: number;
  bgColor: number;
}

const WEATHER_PRESETS: WeatherPreset[] = [
  { name: 'clear',    sunColor: 0xffe8c4, sunIntensity: 2.2, ambientColor: 0x9bb4dd, ambientIntensity: 0.55, hemiSky: 0x88a8d8, hemiGround: 0x20283a, hemiIntensity: 0.75, fogColor: 0x1a2438, fogDensity: 0.003, bgColor: 0x0c1220 },
  { name: 'foggy',    sunColor: 0xc8c0b0, sunIntensity: 1.2, ambientColor: 0x8899aa, ambientIntensity: 0.7,  hemiSky: 0x7788a0, hemiGround: 0x2a3040, hemiIntensity: 0.65, fogColor: 0x2a3348, fogDensity: 0.008, bgColor: 0x151c28 },
  { name: 'overcast', sunColor: 0xd0d0d0, sunIntensity: 1.5, ambientColor: 0x9090a8, ambientIntensity: 0.65, hemiSky: 0x8090a8, hemiGround: 0x252a32, hemiIntensity: 0.7,  fogColor: 0x202838, fogDensity: 0.004, bgColor: 0x101820 },
  { name: 'dusk',     sunColor: 0xff8844, sunIntensity: 1.8, ambientColor: 0x6644aa, ambientIntensity: 0.45, hemiSky: 0x553388, hemiGround: 0x1a1028, hemiIntensity: 0.6,  fogColor: 0x1a1030, fogDensity: 0.005, bgColor: 0x0a0818 },
];

let _sun: THREE.DirectionalLight;
let _ambient: THREE.AmbientLight;
let _hemi: THREE.HemisphereLight;
const _pointLights: THREE.PointLight[] = [];

export function getSunLight(): THREE.DirectionalLight { return _sun; }
export function getAmbientLight(): THREE.AmbientLight { return _ambient; }

export function buildLights(): void {
  const { scene } = gameState;

  // ── AMBIENT + HEMI (much brighter for readability) ──
  _ambient = new THREE.AmbientLight(0x9bb4dd, 0.55);
  scene.add(_ambient);

  _hemi = new THREE.HemisphereLight(0x88a8d8, 0x20283a, 0.75);
  _hemi.position.set(0, 50, 0);
  scene.add(_hemi);

  // ── KEY LIGHT (SUN) — warm, directional ──
  _sun = new THREE.DirectionalLight(0xffe8c4, 2.2);
  _sun.position.set(45, 80, 30);
  _sun.castShadow = true;
  // PERF: 2048² PCF-soft shadows were ~4MB of fill every frame plus a
  // full re-rasterisation of every cast-shadow mesh. At 1024² the visual
  // loss is negligible (soft filter hides stair-stepping) and the GPU cost
  // drops ~4×. Major frame-rate win in firefights because more bots +
  // more muzzle flashes = more surfaces needing shadow lookups.
  _sun.shadow.mapSize.width = 1024;
  _sun.shadow.mapSize.height = 1024;
  _sun.shadow.camera.left = -70;
  _sun.shadow.camera.right = 70;
  _sun.shadow.camera.top = 70;
  _sun.shadow.camera.bottom = -70;
  _sun.shadow.camera.near = 0.5;
  _sun.shadow.camera.far = 200;
  _sun.shadow.bias = -0.0005;
  _sun.shadow.normalBias = 0.04;
  _sun.shadow.radius = 4;
  scene.add(_sun);

  // ── FILL LIGHT — cool, opposite side ──
  const fill = new THREE.DirectionalLight(0x6080c0, 0.55);
  fill.position.set(-30, 40, -20);
  scene.add(fill);

  // ── RIM LIGHT (back light) — cold, for silhouette pop ──
  const rim = new THREE.DirectionalLight(0x4488ff, 0.45);
  rim.position.set(-10, 20, -50);
  scene.add(rim);

  // ── ATMOSPHERIC POINT LIGHTS (brighter, with animated flicker) ──
  const pt = (col: number, x: number, y: number, z: number, intensity: number, distance: number) => {
    const l = new THREE.PointLight(col, intensity, distance, 1.8);
    l.position.set(x, y, z);
    scene.add(l);
    _pointLights.push(l);
    return l;
  };

  // Team base lights — stronger
  pt(0x3b82f6, -50, 8, -50, 18, 45);
  pt(0xef4444, 50, 8, 50, 18, 45);

  // Corner atmosphere
  pt(0x22c55e, -50, 6, 50, 10, 35);
  pt(0xf59e0b, 50, 6, -50, 10, 35);
  pt(0x8b5cf6, 0, 10, 0, 14, 50);

  // Lane markers — lower so they wash walls, flickering subtly
  const lane1 = pt(0x5577cc, -30, 4, 0, 8, 28);
  const lane2 = pt(0x5577cc, 30, 4, 0, 8, 28);
  const lane3 = pt(0x4455aa, 0, 4, -30, 7, 26);
  const lane4 = pt(0x4455aa, 0, 4, 30, 7, 26);

  // Store lane markers for potential future flicker animation
  // (kept in module-level _pointLights array for cleanup)

  // ── SOFTER ATMOSPHERIC FOG — fog-of-mood not fog-of-war ──
  scene.fog = new THREE.FogExp2(0x1a2438, 0.003);
  scene.background = new THREE.Color(0x0c1220);
}

/** Remove all point lights from the scene (call before scene rebuild). */
export function disposeLights(): void {
  for (const l of _pointLights) {
    l.parent?.remove(l);
    l.dispose();
  }
  _pointLights.length = 0;
}

export function applyRandomWeather(): void {
  const preset = WEATHER_PRESETS[Math.floor(Math.random() * WEATHER_PRESETS.length)];
  applyWeather(preset);
}

function applyWeather(p: WeatherPreset): void {
  const { scene } = gameState;
  if (_sun) { _sun.color.set(p.sunColor); _sun.intensity = p.sunIntensity; }
  if (_ambient) { _ambient.color.set(p.ambientColor); _ambient.intensity = p.ambientIntensity; }
  if (_hemi) { _hemi.color.set(p.hemiSky); _hemi.groundColor.set(p.hemiGround); _hemi.intensity = p.hemiIntensity; }
  if (scene.fog instanceof THREE.FogExp2) { scene.fog.color.set(p.fogColor); scene.fog.density = p.fogDensity; }
  if (scene.background instanceof THREE.Color) scene.background.set(p.bgColor);
}
