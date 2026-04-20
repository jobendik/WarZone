import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from './GameState';
import { dom } from '@/ui/DOMElements';

/**
 * Initialize the Three.js scene, camera, renderer, and Yuka managers.
 */
export function initScene(): void {
  const { scene, camera, renderer } = createSceneObjects();

  gameState.scene = scene;
  gameState.camera = camera;
  gameState.renderer = renderer;
  gameState.raycaster = new THREE.Raycaster();
  // PERF: three-mesh-bvh shortcut — tell every BVH traversal to stop at
  // the first intersection instead of sorting the full hit list. Every
  // caller we have (hitscan, pings, movement floor probes, click picker)
  // only ever reads `hits[0]`, so this is a pure win on the hot bullet
  // path and the per-frame movement ray.
  (gameState.raycaster as any).firstHitOnly = true;
  gameState.time = new YUKA.Time();
  gameState.entityManager = new YUKA.EntityManager();
}

function createSceneObjects() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x020810, 0.008);
  scene.background = new THREE.Color(0x020810);

  const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 280);
  camera.rotation.order = 'YXZ';

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  // PERF: cap at 1.0 — higher DPR multiplies fragment-shader cost by DPR².
  // MSAA via `antialias: true` already handles geometry edge smoothing.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.0));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Tone mapping + sRGB output (previously applied only by PostProcess.OutputPass).
  // With composer disabled, the renderer must handle this directly or
  // colors look washed-out / too dark.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  dom.cw.appendChild(renderer.domElement);

  return { scene, camera, renderer };
}
