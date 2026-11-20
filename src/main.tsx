import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/theme.css'
import './styles/base.css'
import './styles/components.css'
import './styles/forms.css'
import './styles/interactions.css'
import './styles/features/workspace.css'
import './styles/features/authentication.css'
import './styles/features/admin.css'
import App from './AuthApp.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
