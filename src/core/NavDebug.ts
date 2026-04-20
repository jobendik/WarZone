/**
 * NavDebug.ts — drop-in debug module for YUKA navmesh + AI in this codebase.
 *
 * Wire in main.ts AFTER agents + navmesh are built:
 *
 *   import { initNavDebug } from '@/debug/NavDebug';
 *   initNavDebug();
 *
 * Keyboard toggles (only when pointer is NOT locked):
 *   5  — toggle navmesh (light green)
 *   6  — toggle region coloring by connected-component island
 *   7  — toggle per-bot overlays (paths, waypoints, current region, target)
 *   8  — toggle path/goal log spam to console
 *   9  — toggle click-to-move test mode (click on navmesh to reroute selected bot)
 *   0  — cycle "selected bot" (focus overlays on one agent)
 *   -  — toggle master panel
 *
 * This file deliberately has ZERO runtime effect when disabled. When disabled
 * its update() is a no-op and no wrappers are active.
 */

import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import type { TDMAgent } from '@/entities/TDMAgent';
import { AsyncPathPlanner, PathPlannerTask } from '@/ai/navigation/PathPlanner';
import { NavAgentRuntime } from '@/ai/navigation/NavAgentRuntime';
import { BLUE_SPAWNS, RED_SPAWNS } from '@/config/constants';
import { STRATEGIC_POSITIONS } from '@/ai/StrategicPositions';

// ─────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────

interface NavDebugState {
    enabled: boolean;
    showNavMesh: boolean;
    showIslands: boolean;
    showBotOverlays: boolean;
    logPathfinding: boolean;
    clickToMove: boolean;
    panelOpen: boolean;
    selectedBotIndex: number;

    navMeshGroup: THREE.Group | null;
    navMeshMaterial: THREE.MeshBasicMaterial | null;
    islandGroup: THREE.Group | null;
    overlayGroup: THREE.Group | null;
    pathLines: Map<string, THREE.Line>;
    waypointSpheres: Map<string, THREE.Object3D[]>;
    targetMarker: THREE.Mesh | null;
    regionHighlight: THREE.Mesh | null;
    clickPlane: THREE.Mesh | null;

    components: number[][];
    regionToComponent: Map<any, number>;

    panelEl: HTMLDivElement | null;
    logEl: HTMLDivElement | null;

    origFindPath: typeof AsyncPathPlanner.prototype.findPath | null;
    origApplyPath: typeof NavAgentRuntime.prototype.applyPath | null;
}

const s: NavDebugState = {
    enabled: false,
    showNavMesh: true,          // start with nav mesh visible so you can SEE it
    showIslands: false,
    showBotOverlays: false,
    logPathfinding: false,
    clickToMove: false,
    panelOpen: true,
    selectedBotIndex: 0,

    navMeshGroup: null,
    navMeshMaterial: null,
    islandGroup: null,
    overlayGroup: null,
    pathLines: new Map(),
    waypointSpheres: new Map(),
    targetMarker: null,
    regionHighlight: null,
    clickPlane: null,

    components: [],
    regionToComponent: new Map(),

    panelEl: null,
    logEl: null,

    origFindPath: null,
    origApplyPath: null,
};

// Shared scratch
const _v = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();
const NAV_DEBUG_ENABLED = new URLSearchParams(globalThis.location?.search ?? '').has('navDebug');

// ─────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────

export function initNavDebug(): void {
    if (!NAV_DEBUG_ENABLED) {
        document.getElementById('navDebugPanel')?.remove();
        return;
    }
    if (s.enabled) return;
    s.enabled = true;

    buildOverlayRoots();
    rebuildNavMeshHelper();
    buildUI();
    installKeyboard();
    installClickToMove();
    installPathfindingHooks();

    logLine('[NavDebug] initialized. 5 navmesh · 6 islands · 7 bot overlays · 8 logs · 9 click-to-move · 0 cycle bot · - panel');
    applyVisibility();
}

/** Call this every frame from GameLoop after entities have moved. */
export function updateNavDebug(): void {
    if (!NAV_DEBUG_ENABLED || !s.enabled) return;
    if (s.showBotOverlays) updateBotOverlays();
}

// ─────────────────────────────────────────────────────────────────────
//  NAVMESH HELPER (light green)
// ─────────────────────────────────────────────────────────────────────

function rebuildNavMeshHelper(): void {
    if (s.navMeshGroup) {
        gameState.scene.remove(s.navMeshGroup);
        disposeGroup(s.navMeshGroup);
        s.navMeshGroup = null;
    }
    if (s.islandGroup) {
        gameState.scene.remove(s.islandGroup);
        disposeGroup(s.islandGroup);
        s.islandGroup = null;
    }

    const nm = gameState.navMeshManager?.navMesh;
    if (!nm) {
        logLine('[NavDebug] No navmesh loaded yet — helper will build when available.');
        return;
    }

    // ── 1. Flat light-green mesh across every region (the "is the navmesh placed correctly?" view) ──
    const positions: number[] = [];
    for (const region of nm.regions) {
        const verts = collectRegionVertices(region);
        for (let i = 1; i < verts.length - 1; i++) {
            positions.push(verts[0].x, verts[0].y + 0.05, verts[0].z);
            positions.push(verts[i].x, verts[i].y + 0.05, verts[i].z);
            positions.push(verts[i + 1].x, verts[i + 1].y + 0.05, verts[i + 1].z);
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
        color: 0x66ff99,              // light green — the explicitly requested color
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
    });
    s.navMeshMaterial = mat;

    const navMesh = new THREE.Mesh(geom, mat);
    navMesh.name = 'NavDebug.NavMesh';

    // Wireframe edges on top for clarity
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom, 1),
        new THREE.LineBasicMaterial({ color: 0x22aa55, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    edges.name = 'NavDebug.NavEdges';

    const group = new THREE.Group();
    group.name = 'NavDebug.NavMeshRoot';
    group.add(navMesh);
    group.add(edges);
    s.navMeshGroup = group;
    gameState.scene.add(group);

    // ── 2. Compute connected components (islands) for the colored view and logging ──
    computeComponents(nm);

    // ── 3. Colored-island helper (only visible when toggled) ──
    s.islandGroup = buildIslandHelper(nm);
    gameState.scene.add(s.islandGroup);

    // ── 4. Click-to-move picking plane: flat quad aligned with navmesh (transparent) ──
    if (s.clickPlane) {
        gameState.scene.remove(s.clickPlane);
        s.clickPlane.geometry.dispose();
    }
    const bbox = new THREE.Box3().setFromBufferAttribute(geom.getAttribute('position') as THREE.BufferAttribute);
    const size = new THREE.Vector3(); bbox.getSize(size);
    const center = new THREE.Vector3(); bbox.getCenter(center);
    s.clickPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(size.x + 10, size.z + 10),
        new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    s.clickPlane.rotation.x = -Math.PI / 2;
    s.clickPlane.position.set(center.x, 0.02, center.z);
    s.clickPlane.name = 'NavDebug.ClickPlane';
    gameState.scene.add(s.clickPlane);

    logLine(
        `[NavDebug] NavMesh helper built: ${nm.regions.length} regions, ${s.components.length} connected component(s). ` +
        `Largest island = ${s.components[0]?.length ?? 0} regions.`
    );
    if (s.components.length > 1) {
        const smalls = s.components.slice(1).map(c => c.length).join(', ');
        logLine(`[NavDebug] ⚠ Disconnected islands detected: ${smalls}. Agents placed on these will not be able to reach the main component.`);
    }

    scanSpawnAndStrategicPositions(nm);
}

/**
 * Report which configured spawn points and strategic positions are off-navmesh
 * or on a different island than the main component. This is the fastest way to
 * tell whether the baked navmesh matches the procedural arena.
 */
function scanSpawnAndStrategicPositions(nm: YUKA.NavMesh): void {
    type Entry = { label: string; x: number; z: number };
    const points: Entry[] = [];
    for (let i = 0; i < BLUE_SPAWNS.length; i++) {
        points.push({ label: `BLUE_SPAWN[${i}]`, x: BLUE_SPAWNS[i][0], z: BLUE_SPAWNS[i][2] });
    }
    for (let i = 0; i < RED_SPAWNS.length; i++) {
        points.push({ label: `RED_SPAWN[${i}]`, x: RED_SPAWNS[i][0], z: RED_SPAWNS[i][2] });
    }
    if (Array.isArray(STRATEGIC_POSITIONS)) {
        for (let i = 0; i < STRATEGIC_POSITIONS.length; i++) {
            const sp = STRATEGIC_POSITIONS[i] as any;
            const p = sp?.pos ?? sp;
            if (p && typeof p.x === 'number' && typeof p.z === 'number') {
                points.push({ label: `STRAT[${i}:${sp?.type ?? '?'}]`, x: p.x, z: p.z });
            }
        }
    }

    const mainIsland = 0;
    let offMesh = 0;
    let offIsland = 0;
    const probe = new YUKA.Vector3();

    for (const p of points) {
        probe.set(p.x, 0, p.z);
        const region = nm.getRegionForPoint(probe, 1);
        if (!region) {
            offMesh++;
            logLine(`[NavDebug] ⚠ ${p.label} at (${p.x},${p.z}) is OFF-NAVMESH.`);
            continue;
        }
        const island = s.regionToComponent.get(region);
        if (island !== mainIsland) {
            offIsland++;
            logLine(`[NavDebug] ⚠ ${p.label} at (${p.x},${p.z}) is on island #${island}, not the main component.`);
        }
    }

    logLine(
        `[NavDebug] Spawn/strategic scan: ${points.length} points, ` +
        `${offMesh} off-mesh, ${offIsland} off-main-island, ` +
        `${points.length - offMesh - offIsland} OK.`
    );
    if (offMesh > 0) {
        logLine(`[NavDebug] ⚠⚠ The navmesh likely does not match the current arena layout — rebake arena_navmesh.gltf or fall back to runtime NavMeshBuilder.`);
    }
}

function collectRegionVertices(region: any): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    if (!region?.edge) return out;
    let e = region.edge;
    let guard = 0;
    do {
        out.push({ x: e.vertex.x, y: e.vertex.y, z: e.vertex.z });
        e = e.next;
        if (++guard > 2000) break;
    } while (e && e !== region.edge);
    return out;
}

function twinRegion(edge: any): any | null {
    const t = edge?.twin;
    if (!t) return null;
    return t.polygon ?? t.face ?? t.region ?? null;
}

function computeComponents(nm: YUKA.NavMesh): void {
    const regions = nm.regions;
    const idx = new Map<any, number>();
    regions.forEach((r, i) => idx.set(r, i));

    const adj: number[][] = regions.map(() => []);
    for (let i = 0; i < regions.length; i++) {
        let e = regions[i].edge;
        let g = 0;
        do {
            const nr = twinRegion(e);
            if (nr && idx.has(nr)) {
                const j = idx.get(nr)!;
                if (j !== i) adj[i].push(j);
            }
            e = e.next;
            if (++g > 2000) break;
        } while (e && e !== regions[i].edge);
    }

    const visited = new Uint8Array(regions.length);
    const comps: number[][] = [];
    for (let i = 0; i < regions.length; i++) {
        if (visited[i]) continue;
        const c: number[] = [];
        const stack = [i];
        visited[i] = 1;
        while (stack.length) {
            const n = stack.pop()!;
            c.push(n);
            for (const m of adj[n]) if (!visited[m]) { visited[m] = 1; stack.push(m); }
        }
        comps.push(c);
    }
    comps.sort((a, b) => b.length - a.length);
    s.components = comps;
    s.regionToComponent.clear();
    for (let ci = 0; ci < comps.length; ci++) {
        for (const ri of comps[ci]) s.regionToComponent.set(regions[ri], ci);
    }
}

function buildIslandHelper(nm: YUKA.NavMesh): THREE.Group {
    const group = new THREE.Group();
    group.name = 'NavDebug.Islands';
    group.visible = false;

    const palette = [0x22cc55, 0xff6644, 0xffaa22, 0x4488ff, 0xaa55ff, 0xff55aa, 0x55ffee, 0xccff55];

    for (let ci = 0; ci < s.components.length; ci++) {
        const color = palette[ci % palette.length];
        const positions: number[] = [];
        for (const ri of s.components[ci]) {
            const region = nm.regions[ri];
            const verts = collectRegionVertices(region);
            for (let i = 1; i < verts.length - 1; i++) {
                positions.push(verts[0].x, verts[0].y + 0.08, verts[0].z);
                positions.push(verts[i].x, verts[i].y + 0.08, verts[i].z);
                positions.push(verts[i + 1].x, verts[i + 1].y + 0.08, verts[i + 1].z);
            }
        }
        if (!positions.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: ci === 0 ? 0.55 : 0.75,    // smaller islands brighter so they stand out
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -5,
        }));
        mesh.name = `NavDebug.Island.${ci}`;
        group.add(mesh);
    }
    return group;
}

// ─────────────────────────────────────────────────────────────────────
//  BOT OVERLAYS
// ─────────────────────────────────────────────────────────────────────

function buildOverlayRoots(): void {
    if (s.overlayGroup) return;
    const g = new THREE.Group();
    g.name = 'NavDebug.Overlays';
    g.visible = false;
    s.overlayGroup = g;
    gameState.scene.add(g);

    // selected-bot target marker (bright cylinder)
    s.targetMarker = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, 0.15, 18),
        new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    s.targetMarker.visible = false;
    g.add(s.targetMarker);

    // current-region highlight
    const rh = new THREE.Mesh(
        new THREE.CircleGeometry(1.5, 24),
        new THREE.MeshBasicMaterial({ color: 0x55ffff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
    );
    rh.rotation.x = -Math.PI / 2;
    rh.visible = false;
    s.regionHighlight = rh;
    g.add(rh);
}

function updateBotOverlays(): void {
    if (!s.overlayGroup) return;

    const bots = gameState.agents.filter(a => a !== gameState.player && !a.isDead);
    const selected = bots[s.selectedBotIndex % Math.max(1, bots.length)];

    // Path lines for ALL bots; thicker for selected
    const live = new Set<string>();
    for (const bot of bots) {
        live.add(bot.name);
        updateBotPathLine(bot, bot === selected);
    }
    // Dispose lines for dead/respawned bots
    for (const [name, line] of s.pathLines) {
        if (!live.has(name)) {
            s.overlayGroup.remove(line);
            line.geometry.dispose();
            (line.material as THREE.Material).dispose();
            s.pathLines.delete(name);
        }
    }

    // Target marker + current region for selected bot
    if (selected && s.targetMarker && s.regionHighlight) {
        const goal = getSelectedGoalTarget(selected);
        if (goal) {
            s.targetMarker.position.set(goal.x, 0.1, goal.z);
            s.targetMarker.visible = true;
        } else {
            s.targetMarker.visible = false;
        }

        const region = selected.navRuntime?.currentRegion;
        if (region?.centroid) {
            s.regionHighlight.position.set(region.centroid.x, 0.04, region.centroid.z);
            s.regionHighlight.visible = true;
        } else {
            s.regionHighlight.visible = false;
        }

        updatePanelText(selected);
    }
}

function updateBotPathLine(bot: TDMAgent, highlight: boolean): void {
    if (!s.overlayGroup) return;

    let line = s.pathLines.get(bot.name);
    const path = bot.navRuntime?.path;

    if (!path || path.length < 2) {
        if (line) line.visible = false;
        return;
    }

    const pts: number[] = [];
    for (const p of path) pts.push(p.x, (p.y ?? 0) + 0.12, p.z);

    if (!line) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const mat = new THREE.LineBasicMaterial({
            color: highlight ? 0xffcc33 : 0x66ddff,
            transparent: true,
            opacity: highlight ? 0.95 : 0.45,
            depthWrite: false,
        });
        line = new THREE.Line(geo, mat);
        line.name = `NavDebug.Path.${bot.name}`;
        s.overlayGroup.add(line);
        s.pathLines.set(bot.name, line);
    } else {
        line.geometry.dispose();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        line.geometry = geo;
        (line.material as THREE.LineBasicMaterial).color.setHex(highlight ? 0xffcc33 : 0x66ddff);
        (line.material as THREE.LineBasicMaterial).opacity = highlight ? 0.95 : 0.45;
        line.visible = true;
    }
}

function getSelectedGoalTarget(bot: TDMAgent): { x: number; y: number; z: number } | null {
    const p = bot.navRuntime?.path;
    if (p && p.length > 0) return { x: p[p.length - 1].x, y: 0, z: p[p.length - 1].z };
    if (bot.currentTarget && !bot.currentTarget.isDead) {
        return { x: bot.currentTarget.position.x, y: 0, z: bot.currentTarget.position.z };
    }
    if (bot.hasLastKnown) return { x: bot.lastKnownPos.x, y: 0, z: bot.lastKnownPos.z };
    return null;
}

// ─────────────────────────────────────────────────────────────────────
//  PATHFINDING LOG + CLICK TO MOVE
// ─────────────────────────────────────────────────────────────────────

function installPathfindingHooks(): void {
    // Wrap AsyncPathPlanner.findPath for logging
    const origFind = AsyncPathPlanner.prototype.findPath;
    s.origFindPath = origFind;
    const self = s;
    AsyncPathPlanner.prototype.findPath = function (vehicle, from, to, callback) {
        const wrapped = (v: any, path: YUKA.Vector3[]) => {
            if (self.logPathfinding) {
                const bot = v as TDMAgent;
                const okRegionFrom = gameState.navMeshManager.navMesh?.getRegionForPoint(from, 1);
                const okRegionTo = gameState.navMeshManager.navMesh?.getRegionForPoint(to, 1);
                logLine(
                    `[Path] ${bot.name ?? '?'}  ` +
                    `from=(${from.x.toFixed(1)},${from.z.toFixed(1)})${okRegionFrom ? '' : ' [off-navmesh]'}  ` +
                    `to=(${to.x.toFixed(1)},${to.z.toFixed(1)})${okRegionTo ? '' : ' [off-navmesh]'}  ` +
                    `waypoints=${path?.length ?? 0}${path?.length ? '' : ' ⚠UNREACHABLE'}`
                );
            }
            callback(v, path);
        };
        return origFind.call(this, vehicle, from, to, wrapped);
    };

    // Wrap NavAgentRuntime.applyPath for logging path apply + clear
    const origApply = NavAgentRuntime.prototype.applyPath;
    s.origApplyPath = origApply;
    NavAgentRuntime.prototype.applyPath = function (path) {
        const ok = origApply.call(this, path);
        if (self.logPathfinding) {
            const name = (this.owner as TDMAgent).name ?? '?';
            if (ok) logLine(`[Path] ${name}  applied path (${path.length} waypoints, active)`);
            else logLine(`[Path] ${name}  applyPath FAILED (empty / no path)`);
        }
        return ok;
    };
}

function installClickToMove(): void {
    const canvas = gameState.renderer?.domElement ?? document.querySelector('canvas');
    if (!canvas) return;
    canvas.addEventListener('pointerdown', (ev) => {
        if (!s.clickToMove) return;
        if ((ev as PointerEvent).button !== 0) return;

        const rect = (canvas as HTMLCanvasElement).getBoundingClientRect();
        _mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, gameState.camera);

        // Test against the invisible click plane so we aren't confused by arena props
        const targets: THREE.Object3D[] = [];
        if (s.clickPlane) targets.push(s.clickPlane);
        const hits = _raycaster.intersectObjects(targets, false);
        if (!hits.length) return;

        const p = hits[0].point;
        const bots = gameState.agents.filter(a => a !== gameState.player && !a.isDead);
        const bot = bots[s.selectedBotIndex % Math.max(1, bots.length)];
        if (!bot) return;

        const nm = gameState.navMeshManager.navMesh;
        if (!nm) { logLine('[Click] No navmesh'); return; }

        const target = new YUKA.Vector3(p.x, 0, p.z);
        const region = nm.getRegionForPoint(target, 1);
        if (!region) {
            logLine(`[Click] (${target.x.toFixed(1)},${target.z.toFixed(1)}) NOT on navmesh`);
            return;
        }
        const comp = s.regionToComponent.get(region);
        const botRegion = bot.navRuntime.currentRegion;
        const botComp = botRegion ? s.regionToComponent.get(botRegion) : -1;
        if (comp !== botComp) {
            logLine(`[Click] Target is on island #${comp}, bot is on island #${botComp}. UNREACHABLE.`);
        }

        // Cancel whatever goal the bot had and force direct movement
        bot.brain.clearSubgoals();
        gameState.pathPlanner?.findPath(bot, bot.position, target, (v: any, path: YUKA.Vector3[]) => {
            (v as TDMAgent).navRuntime.applyPath(path);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────
//  KEYBOARD
// ─────────────────────────────────────────────────────────────────────

function installKeyboard(): void {
    window.addEventListener('keydown', (e) => {
        // Don't hijack input while pointer is locked and user is playing
        if (document.pointerLockElement && e.code !== 'Minus') return;
        switch (e.code) {
            case 'Digit5': s.showNavMesh = !s.showNavMesh; applyVisibility(); logLine(`NavMesh visible: ${s.showNavMesh}`); e.preventDefault(); break;
            case 'Digit6': s.showIslands = !s.showIslands; applyVisibility(); logLine(`Islands colored: ${s.showIslands}`); e.preventDefault(); break;
            case 'Digit7': s.showBotOverlays = !s.showBotOverlays; applyVisibility(); logLine(`Bot overlays: ${s.showBotOverlays}`); e.preventDefault(); break;
            case 'Digit8': s.logPathfinding = !s.logPathfinding; logLine(`Path log: ${s.logPathfinding}`); e.preventDefault(); break;
            case 'Digit9': s.clickToMove = !s.clickToMove; logLine(`Click-to-move: ${s.clickToMove}`); e.preventDefault(); break;
            case 'Digit0': cycleSelectedBot(); e.preventDefault(); break;
            case 'Minus': s.panelOpen = !s.panelOpen; if (s.panelEl) s.panelEl.style.display = s.panelOpen ? 'block' : 'none'; e.preventDefault(); break;
        }
    });
}

function cycleSelectedBot(): void {
    const bots = gameState.agents.filter(a => a !== gameState.player && !a.isDead);
    if (!bots.length) return;
    s.selectedBotIndex = (s.selectedBotIndex + 1) % bots.length;
    logLine(`Selected bot: ${bots[s.selectedBotIndex].name}`);
}

function applyVisibility(): void {
    if (s.navMeshGroup) s.navMeshGroup.visible = s.showNavMesh;
    if (s.islandGroup) s.islandGroup.visible = s.showIslands;
    if (s.overlayGroup) s.overlayGroup.visible = s.showBotOverlays;
}

// ─────────────────────────────────────────────────────────────────────
//  PANEL UI
// ─────────────────────────────────────────────────────────────────────

function buildUI(): void {
    const root = document.createElement('div');
    root.id = 'navDebugPanel';
    root.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 99999;
    width: 360px; max-height: 90vh; overflow: auto;
    background: rgba(10, 16, 28, 0.92);
    color: #c8ddff;
    font: 12px/1.4 ui-monospace, Consolas, monospace;
    padding: 10px 12px; border-radius: 10px;
    border: 1px solid rgba(100, 200, 255, 0.3);
    box-shadow: 0 8px 30px rgba(0,0,0,0.5);
    pointer-events: auto;
  `;
    root.innerHTML = `
    <div style="font-weight: 700; color: #66ff99; margin-bottom: 6px;">NAV DEBUG</div>
    <div style="font-size: 11px; color: #8ab0d0; margin-bottom: 8px;">
      5 mesh · 6 islands · 7 overlay · 8 log · 9 click · 0 cycle · - panel
    </div>
    <div id="navDebugStats" style="margin-bottom: 8px; white-space: pre; color: #a8c4e4;"></div>
    <div style="border-top: 1px solid rgba(100,200,255,0.2); padding-top: 6px; margin-top: 6px;">
      <div style="color: #66ff99; font-weight: 700; margin-bottom: 4px;">SELECTED BOT</div>
      <div id="navDebugBot" style="white-space: pre; color: #d0e4ff;"></div>
    </div>
    <div style="border-top: 1px solid rgba(100,200,255,0.2); padding-top: 6px; margin-top: 8px;">
      <div style="color: #66ff99; font-weight: 700; margin-bottom: 4px;">LOG</div>
      <div id="navDebugLog" style="max-height: 200px; overflow: auto; font-size: 11px; color: #a0b8d0;"></div>
    </div>
  `;
    document.body.appendChild(root);
    s.panelEl = root;
    s.logEl = root.querySelector('#navDebugLog') as HTMLDivElement;

    setInterval(updateStatsText, 500);
}

function updateStatsText(): void {
    if (!s.panelEl) return;
    const el = s.panelEl.querySelector('#navDebugStats') as HTMLDivElement;
    const nm = gameState.navMeshManager?.navMesh;
    const bots = gameState.agents.filter(a => a !== gameState.player && !a.isDead);
    const planner = gameState.pathPlanner;
    const queueLen = (planner as any)?.taskQueue?.tasks?.length ?? '?';

    el.textContent =
        `navmesh:      ${nm ? 'loaded' : 'MISSING'}\n` +
        (nm ? `regions:      ${nm.regions.length}\n` : '') +
        `islands:      ${s.components.length}  (main: ${s.components[0]?.length ?? 0})\n` +
        `agents:       ${bots.length} alive\n` +
        `pathPlanner:  ${planner ? 'present' : 'MISSING'}\n` +
        `queue.len:    ${queueLen}\n` +
        `showNav:${tf(s.showNavMesh)} islands:${tf(s.showIslands)} overlay:${tf(s.showBotOverlays)}\n` +
        `log:${tf(s.logPathfinding)} click:${tf(s.clickToMove)}`;
}

function tf(b: boolean): string { return b ? '✓' : '·'; }

function updatePanelText(bot: TDMAgent): void {
    if (!s.panelEl) return;
    const el = s.panelEl.querySelector('#navDebugBot') as HTMLDivElement;
    const nr = bot.navRuntime;
    const region = nr?.currentRegion;
    const compIdx = region ? s.regionToComponent.get(region) : null;
    const path = nr?.path;
    const ffActive = (nr as any)?.followPathBehavior?.active ?? false;
    const opActive = (nr as any)?.onPathBehavior?.active ?? false;

    const activeSteerings: string[] = [];
    for (const b of (bot as any).steering.behaviors) {
        if (b.active === false) continue;
        if ((b.weight ?? 0) < 0.01 && !(b instanceof YUKA.FollowPathBehavior) && !(b instanceof YUKA.OnPathBehavior)) continue;
        activeSteerings.push(`${b.constructor.name}(w=${(b.weight ?? 1).toFixed(2)})`);
    }

    const vel = bot.velocity;
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

    el.textContent =
        `name:         ${bot.name}  (${bot.botClass}) team=${bot.team}\n` +
        `hp:           ${bot.hp.toFixed(0)}/${bot.maxHP}\n` +
        `state:        ${bot.stateName}\n` +
        `goal:         ${bot.brain.currentSubgoal()?.constructor.name ?? '—'}\n` +
        `pos:          (${bot.position.x.toFixed(1)}, ${bot.position.y.toFixed(2)}, ${bot.position.z.toFixed(1)})\n` +
        `speed:        ${speed.toFixed(2)} / ${bot.maxSpeed.toFixed(1)}\n` +
        `region:       ${region ? 'yes' : 'NONE'}  island=#${compIdx ?? '?'}\n` +
        `path:         ${path ? `${path.length} waypoints` : 'none'}  pending=${(nr as any)?.pathPending ?? false}\n` +
        `followPath:   ${ffActive ? 'active' : 'off'}   onPath: ${opActive ? 'active' : 'off'}\n` +
        `target:       ${bot.currentTarget?.name ?? '—'}\n` +
        `LKP:          ${bot.hasLastKnown ? `(${bot.lastKnownPos.x.toFixed(1)},${bot.lastKnownPos.z.toFixed(1)})` : '—'}\n` +
        `fuzzyAggr:    ${bot.fuzzyAggr.toFixed(1)}\n` +
        `steerings:    ${activeSteerings.join(', ') || 'none'}`;
}

function logLine(msg: string): void {
    if (!s.logEl) { console.log(msg); return; }
    const d = document.createElement('div');
    d.textContent = msg;
    s.logEl.appendChild(d);
    while (s.logEl.children.length > 120) s.logEl.firstChild!.remove();
    s.logEl.scrollTop = s.logEl.scrollHeight;
    console.log(msg);
}

function disposeGroup(g: THREE.Object3D): void {
    g.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) {
            const m = Array.isArray(o.material) ? o.material : [o.material];
            for (const mat of m) mat.dispose?.();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
//  Rebuild helper if navmesh reloads
// ─────────────────────────────────────────────────────────────────────

export function rebuildNavDebug(): void {
    if (!s.enabled) return;
    rebuildNavMeshHelper();
    applyVisibility();
}