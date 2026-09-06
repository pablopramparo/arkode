import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { inProgressRunLabels, confirmInterruptRunningBackups } from './lib/runGuard';
import { Dashboard } from './components/Dashboard';
import { Clientes } from './components/Clientes';
import { ClienteDetalle } from './components/ClienteDetalle';
import { Conexiones } from './components/Conexiones';
import { Tareas } from './components/Tareas';
import { Historial } from './components/Historial';
import { Logs } from './components/Logs';
import { Ayuda } from './components/Ayuda';
import { Configuracion } from './components/Configuracion';
import { AppShell, type Screen } from './components/AppShell';

function App() {
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  // Closing the window kills the engine sidecar, which cuts any manual
  // "Ejecutar ahora" run (scheduled runs are safe — they live in the
  // arkode-scheduler service, not the app). Warn before that happens.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const running = await inProgressRunLabels();
        if (running.length > 0 && !confirmInterruptRunningBackups(running, 'Vas a cerrar Arkode.')) {
          event.preventDefault();
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function navigate(next: Screen) {
    setScreen(next);
    setSelectedClientId(null);
  }

  // A client name is clickable from anywhere in the app — always lands on
  // "Clientes" with that client's ficha open, regardless of which screen it
  // was clicked from.
  function goToClient(clientId: string) {
    setScreen('clientes');
    setSelectedClientId(clientId);
  }

  return (
    <AppShell screen={screen} onNavigate={navigate} onSelectClient={goToClient}>
      {screen === 'dashboard' && <Dashboard onSelectClient={goToClient} />}
      {screen === 'clientes' &&
        (selectedClientId ? (
          <ClienteDetalle clientId={selectedClientId} onBack={() => setSelectedClientId(null)} />
        ) : (
          <Clientes onSelectClient={setSelectedClientId} />
        ))}
      {screen === 'conexiones' && <Conexiones onSelectClient={goToClient} />}
      {screen === 'tareas' && <Tareas onSelectClient={goToClient} />}
      {screen === 'historial' && <Historial onSelectClient={goToClient} />}
      {screen === 'logs' && <Logs onSelectClient={goToClient} />}
      {screen === 'ayuda' && <Ayuda onNavigate={navigate} />}
      {screen === 'configuracion' && <Configuracion />}
    </AppShell>
  );
}

export default App;
