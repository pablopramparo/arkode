import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { resolveApiBase } from './lib/apiBase'

// Must resolve before the first render -- every lib/*Client.ts fetch call
// reads the backend base URL synchronously (see apiBase.ts), so it has to
// already be correct by the time any component's effect fires.
resolveApiBase().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
