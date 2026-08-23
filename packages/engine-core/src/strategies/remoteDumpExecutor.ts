import type { BackupStrategyContext, BackupStrategyExecutor, ProducedDump } from './types.js';

/**
 * NOT IMPLEMENTED — per the agreed architecture plan, remote_dump (generate
 * a dump via SSH exec, then download it) is a later increment, not part of
 * the SFTP-only vertical slice. This stub exists so the orchestrator's
 * strategy registry is real and fully typed today, and adding the real
 * implementation later requires no changes to the orchestrator itself.
 */
export function createRemoteDumpExecutor(): BackupStrategyExecutor {
  return {
    kind: 'remote_dump',
    async produce(_ctx: BackupStrategyContext): Promise<ProducedDump> {
      throw new Error('remote_dump strategy is not implemented yet.');
    },
  };
}
