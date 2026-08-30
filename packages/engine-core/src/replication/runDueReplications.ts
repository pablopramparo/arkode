import { isReplicationDue, type ReplicationDueDeps, type IsReplicationDueOptions } from './replicationDue.js';
import { replicateTarget, type ReplicateTargetDeps, type ReplicateTargetResult } from './replicateTarget.js';
import type { ReplicationTarget } from './types.js';

export interface ReplicationRunDueResult {
  targetId: string;
  clientId: string;
  content: ReplicationTarget['content'];
  ran: boolean;
  result?: ReplicateTargetResult;
  error?: string;
}

/**
 * The scheduler-tick entry point: for every enabled target, replicate it if
 * `isReplicationDue`. Failures are isolated per target — `replicateTarget`
 * already folds ordinary sync failures into the target's own run row, and
 * this additionally catches an unexpected throw so one bad target can't
 * stop the rest.
 */
export async function runDueReplications(
  targets: ReplicationTarget[],
  deps: ReplicateTargetDeps & ReplicationDueDeps,
  now: Date = new Date(),
  dueOpts: IsReplicationDueOptions = {}
): Promise<ReplicationRunDueResult[]> {
  const results: ReplicationRunDueResult[] = [];
  for (const target of targets) {
    if (!isReplicationDue(target, deps, { ...dueOpts, now })) {
      results.push({ targetId: target.id, clientId: target.clientId, content: target.content, ran: false });
      continue;
    }
    try {
      const result = await replicateTarget(deps, target.id, { trigger: 'scheduled' });
      results.push({
        targetId: target.id,
        clientId: target.clientId,
        content: target.content,
        ran: result.ran,
        result,
      });
    } catch (err) {
      results.push({
        targetId: target.id,
        clientId: target.clientId,
        content: target.content,
        ran: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
