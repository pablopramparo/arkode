import { useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { Clientes } from './components/Clientes';
import { Conexiones } from './components/Conexiones';
import { AppShell, type Screen } from './components/AppShell';

function App() {
  const [screen, setScreen] = useState<Screen>('dashboard');

  return (
    <AppShell screen={screen} onNavigate={setScreen}>
      {screen === 'dashboard' && <Dashboard />}
      {screen === 'clientes' && <Clientes />}
      {screen === 'conexiones' && <Conexiones />}
    </AppShell>
  );
}

export default App;
