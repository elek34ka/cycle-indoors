import { settings } from '../core/settings';
import { strava } from '../activity/strava';
import { clear, el, qs, toast } from './dom';

/** The Settings tab's Strava section: connect, who is connected, auto-upload, disconnect. */
export function buildStravaPanel(): void {
  const host = qs('#strava-panel');

  const render = () => {
    clear(host);
    host.append(el('h2', { text: 'Strava' }));
    const status = strava.status;

    if (status === 'connecting') {
      host.append(
        el('p', { class: 'hint', text: 'Waiting for Strava… Approve Cycle Indoors in the pop-up window.' }),
        el('div', { class: 'summary-actions' }, [
          el('button', { class: 'btn', text: 'Cancel', on: { click: () => strava.cancelConnect() } }),
        ]),
      );
      return;
    }

    if (status === 'disconnected') {
      host.append(
        el('p', {
          class: 'hint',
          text: 'Upload finished rides straight to Strava. You approve once in this browser; '
            + 'it stays connected until you disconnect or clear this site’s data.',
        }),
        el('div', { class: 'summary-actions' }, [
          el('button', { class: 'btn btn-primary', text: 'Connect to Strava', on: { click: () => void connectStrava() } }),
        ]),
      );
      return;
    }

    const auto = el('input', { type: 'checkbox' }) as HTMLInputElement;
    auto.checked = settings.current.stravaAutoUpload;
    auto.addEventListener('change', () => settings.patch({ stravaAutoUpload: auto.checked }));

    host.append(
      el('p', { class: 'hint', text: strava.athleteName ? `Connected as ${strava.athleteName}.` : 'Connected.' }),
      el('label', { class: 'toggle-row' }, [
        auto,
        el('div', {}, [
          el('div', { class: 'toggle-label', text: 'Upload automatically when I finish' }),
          el('div', { class: 'suffix', text: 'Off, each ride waits for Upload to Strava on the summary.' }),
        ]),
      ]),
      el('div', { class: 'summary-actions' }, [
        el('button', {
          class: 'btn',
          text: 'Disconnect',
          on: {
            click: async () => {
              await strava.disconnect();
              toast('Disconnected from Strava.');
            },
          },
        }),
      ]),
    );
  };

  strava.on('status', render);
  // "Reset to defaults" turns auto-upload off.
  settings.on('change', () => {
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (box) box.checked = settings.current.stravaAutoUpload;
  });
  render();
}

/** Connect, telling the rider how it went. Resolves true once connected. */
export async function connectStrava(): Promise<boolean> {
  try {
    await strava.connect();
    toast(strava.athleteName ? `Connected to Strava as ${strava.athleteName}.` : 'Connected to Strava.');
    return true;
  } catch (err) {
    toast((err as Error).message, 'error');
    return false;
  }
}
