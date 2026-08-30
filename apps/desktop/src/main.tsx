import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StandaloneDesktopWidget } from './DesktopWidget';
import './styles.css';

const isWidgetWindow = window.location.search.includes('window=widget');
const isWidgetPreview = window.location.search.includes('window=widget-preview');

function WidgetPreviewWrapper() {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background:
          'radial-gradient(ellipse at center, #242c27 0%, #151a17 60%, #0d100e 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        boxSizing: 'border-box',
      }}
    >
      <StandaloneDesktopWidget />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isWidgetPreview ? (
      <WidgetPreviewWrapper />
    ) : isWidgetWindow ? (
      <StandaloneDesktopWidget />
    ) : (
      <App />
    )}
  </StrictMode>,
);
