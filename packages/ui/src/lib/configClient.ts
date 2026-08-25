import type { ImportConfigResult, SystemInfo, PostgresToolPaths, MysqlToolPaths, MariaDbToolPaths } from 'engine-core';
import { getApiBase } from './apiBase';

// A function, not a precomputed constant: it's used to build an <a href>,
// which needs the real (possibly fallback) port -- see apiBase.ts -- and a
// module-level `const` would have frozen in whatever getApiBase() returned
// at import time, before resolveApiBase() (in main.tsx) had a chance to run.
export function configExportUrl(): string {
  return `${getApiBase()}/config/export`;
}

export async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await fetch(`${getApiBase()}/system`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export async function importConfig(data: unknown): Promise<ImportConfigResult> {
  const res = await fetch(`${getApiBase()}/config/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export type ToolRegistryEngine = 'postgres' | 'mysql' | 'mariadb';

export interface ToolRegistryData {
  postgres: Record<string, PostgresToolPaths>;
  mysql: Record<string, MysqlToolPaths>;
  mariadb: Record<string, MariaDbToolPaths>;
}

async function handleToolRegistryJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function fetchToolRegistry(): Promise<ToolRegistryData> {
  return handleToolRegistryJson(await fetch(`${getApiBase()}/tool-registry`));
}

/**
 * `paths` is deliberately typed loosely (not the PostgresToolPaths/MysqlToolPaths/
 * MariaDbToolPaths union) since the caller (ToolRegistrySection, a single
 * component shared across all three engines) only knows field names/values
 * generically — the server validates the actual required keys per engine.
 */
export async function registerTool(engine: ToolRegistryEngine, version: string, paths: Record<string, string>): Promise<void> {
  await handleToolRegistryJson(
    await fetch(`${getApiBase()}/tool-registry/${engine}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, ...paths }),
    })
  );
}

export async function unregisterTool(engine: ToolRegistryEngine, version: string): Promise<void> {
  await handleToolRegistryJson(
    await fetch(`${getApiBase()}/tool-registry/${engine}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    })
  );
}
