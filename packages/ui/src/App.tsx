import { useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { Clientes } from './components/Clientes';
import { ClienteDetalle, type ProjectTab } from './components/ClienteDetalle';
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
  const [selectedClientProjectTab, setSelectedClientProjectTab] = useState<ProjectTab | undefined>(undefined);
  const [selectedClientProjectItemId, setSelectedClientProjectItemId] = useState<string | undefined>(undefined);

  function selectClientFromList(clientId: string | null) {
    setSelectedClientId(clientId);
    setSelectedClientProjectTab(undefined);
    setSelectedClientProjectItemId(undefined);
  }

  // NOTE: there is deliberately NO onCloseRequested guard here. A previous
  // one (v0.5.4) trapped the window shut when its confirm didn't render
  // during the close event. Closing during a manual "Ejecutar ahora" just
  // interrupts that run — it's marked "Interrumpida" and retried next time,
  // no data loss — which isn't worth the risk of not being able to close.

  function navigate(next: Screen) {
    setScreen(next);
    selectClientFromList(null);
  }

  // A client name is clickable from anywhere in the app — always lands on
  // "Clientes" with that client's ficha open, regardless of which screen it
  // was clicked from. A global-search hit on vault content also passes the
  // Proyecto sub-tab to open and, when it points at one item, its id so the
  // ficha opens that credential/URL/item's detail directly.
  function goToClient(clientId: string, projectTab?: ProjectTab, projectItemId?: string) {
    setScreen('clientes');
    setSelectedClientId(clientId);
    setSelectedClientProjectTab(projectTab);
    setSelectedClientProjectItemId(projectItemId);
  }

  return (
    <AppShell screen={screen} onNavigate={navigate} onSelectClient={goToClient}>
      {screen === 'dashboard' && <Dashboard onSelectClient={goToClient} />}
      {screen === 'clientes' &&
        (selectedClientId ? (
          <ClienteDetalle
            clientId={selectedClientId}
            initialProjectTab={selectedClientProjectTab}
            initialProjectItemId={selectedClientProjectItemId}
            onBack={() => selectClientFromList(null)}
          />
        ) : (
          <Clientes onSelectClient={selectClientFromList} />
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
