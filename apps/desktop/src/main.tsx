import { initializeRepositoryStorage } from './repositoryStorage';
import './styles.css';

// Do not mount UI or start runtime restoration before durable storage is ready.
initializeRepositoryStorage()
  .then(() => import('./renderApp'))
  .catch((error: unknown) => {
    const root = document.getElementById('root');
    if (!root) return;
    const panel = document.createElement('section');
    panel.style.cssText = 'max-width:640px;margin:15vh auto;padding:32px';
    const title = document.createElement('h1');
    title.textContent = 'IRIS could not open its local database';
    const message = document.createElement('p');
    message.textContent = error instanceof Error ? error.message : String(error);
    const help = document.createElement('p');
    help.textContent =
      'Your existing data has been retained. Restart IRIS after resolving the storage error.';
    panel.append(title, message, help);
    root.replaceChildren(panel);
  });
