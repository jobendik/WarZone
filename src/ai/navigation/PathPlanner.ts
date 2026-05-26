import * as YUKA from 'yuka';
import { perf } from '@/core/PerfProfiler';
import type { NavMeshManager } from './NavMeshManager';

/**
 * Kept for backwards compatibility with code that references this class
 * (e.g. NavDebug hooks). It is now a thin wrapper: AsyncPathPlanner
 * executes it immediately rather than going through YUKA's idle task queue.
 */
export class PathPlannerTask extends YUKA.Task {
  planner: AsyncPathPlanner;
  vehicle: any;
  from: YUKA.Vector3;
  to: YUKA.Vector3;
  callback: (vehicle: any, path: YUKA.Vector3[]) => void;

  constructor(
    planner: AsyncPathPlanner,
    vehicle: any,
    from: YUKA.Vector3,
    to: YUKA.Vector3,
    callback: (vehicle: any, path: YUKA.Vector3[]) => void
  ) {
    super();
    this.planner = planner;
    this.vehicle = vehicle;
    this.from = from.clone();
    this.to = to.clone();
    this.callback = callback;
  }

  execute(): void {
    let path: YUKA.Vector3[] = [];
    try {
      perf.begin('nav.findPath.core');
      const result = this.planner.navManager.findPath(this.from, this.to);
      perf.end('nav.findPath.core');
      if (Array.isArray(result)) path = result;
    } catch (err) {
      perf.end('nav.findPath.core');
      console.warn('[PathPlannerTask] navManager.findPath threw:', err);
    }
    try {
      this.callback(this.vehicle, path);
    } catch (err) {
      console.warn('[PathPlannerTask] callback threw:', err);
    }
  }
}

/**
 * Synchronous path planner.
 *
 * Previously this wrapped YUKA.TaskQueue (requestIdleCallback). In practice
 * a 60 fps render loop leaves almost no idle budget, and if a single
 * task.execute() ever threw, YUKA's internal queue would permanently stop
 * draining — every subsequent findPath request piled up, `pathPending`
 * stayed true for every bot, FollowPathBehavior never activated, and bots
 * only moved via SeekBehavior directly toward enemies (walking through
 * walls in the process).
 *
 * A pathfinding query on our ~945-region main component is sub-millisecond,
 * so we just execute it inline. `update()` is kept as a no-op so existing
 * callers that invoke it per frame still compile.
 */
export class AsyncPathPlanner {
  navManager: NavMeshManager;

  constructor(navManager: NavMeshManager) {
    this.navManager = navManager;
  }

  findPath(
    vehicle: any,
    from: YUKA.Vector3,
    to: YUKA.Vector3,
    callback: (vehicle: any, path: YUKA.Vector3[]) => void
  ): void {
    perf.begin('nav.findPath.total');
    const task = new PathPlannerTask(this, vehicle, from, to, callback);
    task.execute();
    perf.end('nav.findPath.total');
  }

  // Kept for API compatibility (GameLoop calls this every frame).
  update(): void {}
}
