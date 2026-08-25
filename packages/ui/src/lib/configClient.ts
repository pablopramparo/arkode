import type { ImportConfigResult, SystemInfo, PostgresToolPaths, MysqlToolPaths, MariaDbToolPaths } from 'engine-core';

// Dev-time only: talks to `engine-cli serve` directly over HTTP — see statusClient.ts.
const BASE_URL = 'http://127.0.0.1:4287';

export const CONFIG_EXPORT_URL = `${BASE_URL}/config/export`;

export async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await fetch(`${BASE_URL}/system`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export async function importConfig(data: unknown): Promise<ImportConfigResult> {
  const res = await fetch(`${BASE_URL}/config/import`, {
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
  return handleToolRegistryJson(await fetch(`${BASE_URL}/tool-registry`));
}

/**
 * `paths` is deliberately typed loosely (not the PostgresToolPaths/MysqlToolPaths/
 * MariaDbToolPaths union) since the caller (ToolRegistrySection, a single
 * component shared across all three engines) only knows field names/values
 * generically — the server validates the actual required keys per engine.
 */
export async function registerTool(engine: ToolRegistryEngine, version: string, paths: Record<string, string>): Promise<void> {
  await handleToolRegistryJson(
    await fetch(`${BASE_URL}/tool-registry/${engine}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, ...paths }),
    })
  );
}

export async function unregisterTool(engine: ToolRegistryEngine, version: string): Promise<void> {
  await handleToolRegistryJson(
    await fetch(`${BASE_URL}/tool-registry/${engine}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    })
  );
}
