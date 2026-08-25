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

/** postgres/mariadb only — see downloadTool.ts's own doc comment for why mysql is excluded. exactVersion is the vendor's real release string (e.g. "18.6-1" for postgres, "11.5.2" for mariadb), distinct from `version` (the registry key this gets registered under, e.g. "18" or "11.5"). Can take a while for postgres (~344MB) — no client-side timeout is set. */
export async function downloadTool(
  engine: 'postgres' | 'mariadb',
  version: string,
  exactVersion: string
): Promise<Record<string, string>> {
  const body = await handleToolRegistryJson<{ ok: true; paths: Record<string, string> }>(
    await fetch(`${getApiBase()}/tool-registry/${engine}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, exactVersion }),
    })
  );
  return body.paths;
}
