import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StandaloneDesktopWidget } from './DesktopWidget';
import './styles.css';

const isWidgetWindow = window.location.search.includes('window=widget');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isWidgetWindow ? <StandaloneDesktopWidget /> : <App />}
  </StrictMode>,
);
