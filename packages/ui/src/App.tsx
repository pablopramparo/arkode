import { useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { Clientes } from './components/Clientes';

type Screen = 'dashboard' | 'clientes';

const TABS: { id: Screen; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'clientes', label: 'Clientes' },
];

function App() {
  const [screen, setScreen] = useState<Screen>('dashboard');

  return (
    <div>
      <nav className="border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="mx-auto flex max-w-5xl gap-1 px-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setScreen(tab.id)}
              className="px-3 py-2.5 text-sm font-medium"
              style={{
                color: screen === tab.id ? 'var(--foreground)' : 'var(--muted)',
                borderBottom: screen === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>
      {screen === 'dashboard' ? <Dashboard /> : <Clientes />}
    </div>
  );
}

export default App;
