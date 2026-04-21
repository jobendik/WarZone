import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import { TDMAgent } from './TDMAgent';
import {
  TEAM_BLUE, TEAM_RED, TEAM_COLORS,
  BLUE_SPAWNS, RED_SPAWNS,
  ARENA_BLUE_BOT_COUNT, ARENA_RED_BOT_COUNT,
} from '@/config/constants';
import type { BotClass } from '@/config/classes';
import type { TeamId } from '@/config/constants';
import { FP } from '@/config/player';
import { buildSoldierMesh } from '@/rendering/SoldierMesh';
import { makeNameTag } from '@/rendering/NameTag';
import { addHPBar } from '@/rendering/HPBar';
import { NavAgentRuntime } from '@/ai/navigation/NavAgentRuntime';
import { setupFuzzy } from '@/ai/FuzzyLogic';
import { makePersonality } from '@/ai/Personality';
import { resolveArenaSpawn } from '@/core/GameModes';
import {
  preloadBlueSwatAssets, preloadEnemyAssets,
  hasBlueSwatAssets, hasEnemyAssets,
  attachBlueSwatCharacter, attachEnemyCharacter,
} from '@/rendering/AgentAnimations';
import {
  AttackEvaluator, SurviveEvaluator, ReloadEvaluator,
  SeekHealthEvaluator, GetWeaponEvaluator, HuntEvaluator, PatrolEvaluator,
  HoldAngleEvaluator,
} from '@/ai/goals/Evaluators';

/** Sync callback for YUKA render component — lets YUKA drive position + rotation. */
function syncRC(entity: YUKA.GameEntity, renderComponent: THREE.Object3D): void {
  renderComponent.position.copy(entity.position as unknown as THREE.Vector3);
  renderComponent.quaternion.copy(entity.rotation as unknown as THREE.Quaternion);
}

type VisualVariant = 'placeholder' | 'swat' | 'enemy';

function mkAgent(
  name: string,
  team: TeamId,
  botClass: BotClass,
  x: number,
  z: number,
  visualVariant: VisualVariant = 'placeholder',
): TDMAgent {
  const ag = new TDMAgent(name, team, botClass);
  ag.position.set(x, 0, z);
  ag.spawnPos.set(x, 0, z);

  // ── Personality — assigned BEFORE evaluators so they can read it ──
  const personality = makePersonality(botClass);
  ag.personality = personality;

  // Personality shifts reaction time and preferred range
  ag.reactionTime = Math.max(0.12, ag.reactionTime + personality.reactionModifier);
  ag.preferredRange *= 1 + personality.patienceBias * 0.15;

  const root = new THREE.Group();
  root.name = `${name}_Root`;
  gameState.scene.add(root);

  ag.renderComponent = root;
  ag.setRenderComponent(root, syncRC);

  if (visualVariant === 'swat') attachBlueSwatCharacter(root);
  else if (visualVariant === 'enemy') attachEnemyCharacter(root);
  else root.add(buildSoldierMesh(TEAM_COLORS[team], botClass, team));

  const tag = makeNameTag(name, TEAM_COLORS[team]);
  tag.position.y = 2.6;
  root.add(tag);
  ag.nameTag = tag;

  addHPBar(ag);

  // Steering behaviors
  ag.wanderB = new YUKA.WanderBehavior(1.0, 4, 2.2);
  ag.arriveB = new YUKA.ArriveBehavior(new YUKA.Vector3(), 3, 0.5);
  ag.seekB = new YUKA.SeekBehavior(new YUKA.Vector3());
  ag.fleeB = new YUKA.FleeBehavior(new YUKA.Vector3(), 10);
  ag.pursuitB = new YUKA.PursuitBehavior(ag, 1.2);
  ag.avoidB = new YUKA.ObstacleAvoidanceBehavior(gameState.yukaObs);
  ag.avoidB.weight = 1.2;

  ag.steering.add(ag.wanderB);
  ag.steering.add(ag.arriveB);
  ag.steering.add(ag.seekB);
  ag.steering.add(ag.fleeB);
  ag.steering.add(ag.pursuitB);
  ag.steering.add(ag.avoidB);

  // Setup NavMesh proper runtime
  ag.navRuntime = new NavAgentRuntime(ag, gameState.navMeshManager);
  ag.navRuntime.initFromSpawn(ag.spawnPos);

  ag.wanderB.weight = 1;
  ag.arriveB.weight = 0;
  ag.seekB.weight = 0;
  ag.fleeB.weight = 0;
  ag.pursuitB.weight = 0;

  // Evaluator biases — combine class base with personality bias
  const classAggr =
    botClass === 'assault' ? 1.1 :
    botClass === 'flanker' ? 1.05 :
    botClass === 'sniper'  ? 0.85 : 1.0;

  const classSurv =
    botClass === 'sniper' ? 1.2 :
    botClass === 'assault' ? 0.85 : 1.0;

  const aggrBias = Math.max(0.3, classAggr + personality.aggressionBias);
  const survBias = Math.max(0.3, classSurv + personality.cautionBias);

  ag.brain.addEvaluator(new AttackEvaluator(aggrBias));
  ag.brain.addEvaluator(new SurviveEvaluator(survBias));
  ag.brain.addEvaluator(new ReloadEvaluator(1.0 + (Math.random() - 0.5) * 0.1));
  ag.brain.addEvaluator(new SeekHealthEvaluator(Math.max(0.5, 1.0 + personality.cautionBias * 0.3)));
  ag.brain.addEvaluator(new GetWeaponEvaluator(0.9 + (Math.random() - 0.5) * 0.1));
  ag.brain.addEvaluator(new HuntEvaluator(Math.max(0.3, aggrBias * 0.95 + personality.egoismBias * 0.3)));
  ag.brain.addEvaluator(new HoldAngleEvaluator(Math.max(0.3, 1.0 + personality.patienceBias * 0.5)));
  ag.brain.addEvaluator(new PatrolEvaluator(1.0));

  setupFuzzy(ag);

  ag.perceptionSlot = gameState.agents.length % 3;

  gameState.entityManager.add(ag);
  gameState.agents.push(ag);

  return ag;
}

export async function buildAgents(): Promise<void> {
  let blueSwatReady = false;
  let enemyReady = false;

  try {
    await preloadBlueSwatAssets();
    blueSwatReady = hasBlueSwatAssets();
  } catch (err) {
    console.error('[AgentFactory] Failed to preload SWAT assets.', err);
  }

  try {
    await preloadEnemyAssets();
    enemyReady = hasEnemyAssets();
  } catch (err) {
    console.error('[AgentFactory] Failed to preload enemy assets.', err);
  }

  // Player
  const playerSpawn = resolveArenaSpawn(BLUE_SPAWNS[0], TEAM_BLUE);
  const player = new TDMAgent('Player', TEAM_BLUE, 'rifleman');
  player.position.set(playerSpawn[0], 0, playerSpawn[2]);
  player.spawnPos.set(playerSpawn[0], 0, playerSpawn[2]);
  player.maxSpeed = FP.moveSpeed;
  player.boundingRadius = 0.55;

  const pmesh = new THREE.Group();
  pmesh.visible = false;
  gameState.scene.add(pmesh);
  player.renderComponent = pmesh;
  player.setRenderComponent(pmesh, syncRC);
  gameState.entityManager.add(player);
  gameState.agents.push(player);
  player.hp = gameState.pHP;
  gameState.player = player;

  // Blue team AI
  const blueClasses: BotClass[] = ['rifleman', 'rifleman', 'assault', 'sniper', 'flanker', 'assault'];
  const blueNames = ['Falcon', 'Blaze', 'Storm', 'Ghost', 'Hawk', 'Rook'];
  for (let i = 0; i < ARENA_BLUE_BOT_COUNT; i++) {
    const rawSpawn = BLUE_SPAWNS[i + 1] || BLUE_SPAWNS[i % BLUE_SPAWNS.length];
    const sp = resolveArenaSpawn(rawSpawn, TEAM_BLUE);
    const bot = mkAgent(
      blueNames[i], TEAM_BLUE, blueClasses[i], sp[0], sp[2],
      blueSwatReady ? 'swat' : 'placeholder',
    );
    if (bot.personality) {
      console.info(`[AI] ${bot.name} (${bot.botClass}) → ${bot.personality.archetype}, skill=${bot.personality.skill.toFixed(2)}`);
    }
  }

  // Red team AI
  const redClasses: BotClass[] = ['rifleman', 'rifleman', 'assault', 'assault', 'sniper', 'flanker', 'rifleman'];
  const redNames = ['Demon', 'Inferno', 'Hammer', 'Fang', 'Specter', 'Viper', 'Reaper'];
  for (let i = 0; i < ARENA_RED_BOT_COUNT; i++) {
    const sp = resolveArenaSpawn(RED_SPAWNS[i % RED_SPAWNS.length], TEAM_RED);
    const bot = mkAgent(
      redNames[i], TEAM_RED, redClasses[i], sp[0], sp[2],
      enemyReady ? 'enemy' : 'placeholder',
    );
    if (bot.personality) {
      console.info(`[AI] ${bot.name} (${bot.botClass}) → ${bot.personality.archetype}, skill=${bot.personality.skill.toFixed(2)}`);
    }
  }
}
