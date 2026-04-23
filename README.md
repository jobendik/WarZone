# WarZone

A fast-paced first-person team deathmatch game built with **Three.js** and **YUKA.js** AI framework. Play alongside AI teammates against an enemy AI team in an arena-style shooter.

## Features

- **First-Person Shooter** — WASD movement, mouse aiming, hitscan + projectile weapons
- **Goal-Driven AI** — Bots use YUKA.js Think/GoalEvaluator architecture for human-like decision making
- **4 Bot Classes** — Rifleman, Assault, Sniper, Flanker — each with unique stats, weapon preferences, and combat behaviors
- **7 Weapons** — Pistol, SMG, Assault Rifle, Shotgun, Sniper Rifle, Rocket Launcher, plus grenades
- **Rocket Launcher** — Fires projectiles with smoke trails and large splash-damage explosions
- **Fuzzy Logic** — Aggression evaluation using fuzzy sets for nuanced combat decisions
- **Team Coordination** — Bots share enemy callouts, execute team pushes, and provide suppressive fire
- **Dynamic Combat** — Burst fire, headshots, combat strafing, damage reactions, cover usage, flanking
- **Pickup System** — Health, ammo, and weapon pickups scattered across the arena
- **Round System** — First team to 10 kills wins; animated round summary with MVP, podium, and full stats
- **Visual Effects** — Muzzle flashes, tracers, wall sparks, death explosions, screen shake
- **HUD** — Health bar, ammo counter, crosshair, minimap, killfeed, scoreboard, kill notifications

## Controls

| Key | Action |
|-----|--------|
| W/A/S/D | Move |
| Mouse | Look |
| LMB | Shoot |
| R | Reload |
| G | Throw grenade |
| 1/2/3 | Switch weapon slot |
| Scroll | Cycle weapons |
| Shift | Sprint |
| Tab | Scoreboard |

## Tech Stack

- [Three.js](https://threejs.org/) — 3D rendering
- [YUKA](https://mugen87.github.io/yuka/) — AI framework (steering behaviors, goal-driven architecture, fuzzy logic, state machines)
- [TypeScript](https://www.typescriptlang.org/) — Type-safe codebase
- [Vite](https://vitejs.dev/) — Build tool and dev server

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and click to lock the pointer and start playing.

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Project Structure

```
src/
  ai/          — AI controller, perception, fuzzy logic, cover system, goals & evaluators
  combat/      — Hitscan, projectiles, particles, pickups, combat logic
  config/      — Weapon definitions, class configs, constants
  core/        — Game loop, game state, scene setup, event manager
  entities/    — Player controller, TDMAgent, agent factory
  rendering/   — Soldier meshes, animations, HP bars, name tags, weapon viewmodel
  ui/          — HUD, scoreboard, killfeed, minimap, round summary
  world/       — Arena geometry, cover points, lighting
```

## License

MIT
