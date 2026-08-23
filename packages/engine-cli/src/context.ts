import {
  getDb,
  runMigrations,
  createClientsRepo,
  createTransportsRepo,
  createDatabaseConnectionsRepo,
  createTasksRepo,
  createRunsRepo,
  createKnownHostsRepo,
  createLogEventsRepo,
  createSettingsRepo,
  WindowsCredentialManagerStore,
} from 'engine-core';

export function buildContext() {
  const db = getDb();
  runMigrations(db);

  const clientsRepo = createClientsRepo(db);
  const transportsRepo = createTransportsRepo(db);
  const databaseConnectionsRepo = createDatabaseConnectionsRepo(db);
  const tasksRepo = createTasksRepo(db, transportsRepo);
  const runsRepo = createRunsRepo(db);
  const knownHostsRepo = createKnownHostsRepo(db);
  const logEventsRepo = createLogEventsRepo(db);
  const settingsRepo = createSettingsRepo(db);
  const secretStore = new WindowsCredentialManagerStore();

  return {
    db,
    clientsRepo,
    transportsRepo,
    databaseConnectionsRepo,
    tasksRepo,
    runsRepo,
    knownHostsRepo,
    logEventsRepo,
    settingsRepo,
    secretStore,
  };
}

export type Context = ReturnType<typeof buildContext>;
