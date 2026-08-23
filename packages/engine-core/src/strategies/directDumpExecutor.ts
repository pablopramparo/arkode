import type { BackupStrategyContext, BackupStrategyExecutor, ProducedDump } from './types.js';

/**
 * NOT IMPLEMENTED — direct_dump (connect straight to Postgres/MySQL from this
 * PC using SecretStore-held credentials and run the dump client locally) is
 * an explicitly future strategy. This stub, plus the database_connections
 * table and the DatabaseDumpClient interface it will use, exist now so this
 * strategy is additive later rather than a schema/orchestrator rewrite.
 */
export function createDirectDumpExecutor(): BackupStrategyExecutor {
  return {
    kind: 'direct_dump',
    async produce(_ctx: BackupStrategyContext): Promise<ProducedDump> {
      throw new Error('direct_dump strategy is not implemented yet.');
    },
  };
}
