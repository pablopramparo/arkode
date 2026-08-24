import { useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { Clientes } from './components/Clientes';
import { Conexiones } from './components/Conexiones';
import { Tareas } from './components/Tareas';
import { Historial } from './components/Historial';
import { AppShell, type Screen } from './components/AppShell';

function App() {
  const [screen, setScreen] = useState<Screen>('dashboard');

  return (
    <AppShell screen={screen} onNavigate={setScreen}>
      {screen === 'dashboard' && <Dashboard />}
      {screen === 'clientes' && <Clientes />}
      {screen === 'conexiones' && <Conexiones />}
      {screen === 'tareas' && <Tareas />}
      {screen === 'historial' && <Historial />}
    </AppShell>
  );
}

export default App;
