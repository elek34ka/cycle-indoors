import './styles.css';
import { bootApp } from './ui/app';
import { toast } from './ui/dom';

window.addEventListener('error', (e) => console.error('unhandled error', e.error));
window.addEventListener('unhandledrejection', (e) => console.error('unhandled rejection', e.reason));

try {
  bootApp();
} catch (err) {
  console.error(err);
  toast(`Startup failed: ${(err as Error).message}`, 'error');
}
