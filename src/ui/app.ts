import { hub } from '../devices/hub';
import { registerMockDevices, mock } from '../devices/setup';
import { restorePairedDevices } from '../devices/ble/pair';
import { settings } from '../core/settings';
import { keepScreenAwake } from '../core/wake-lock';
import { session } from '../session/session';
import { DevicesView } from './devices-view';
import { RideView } from './ride-view';
import { buildSettingsView } from './settings-view';
import { showSummary } from './summary';
import { qs, toast } from './dom';

type TabName = 'ride' | 'settings';

export function bootApp(): void {
  new RideView((snapshot) => showSummary(snapshot));
  buildSettingsView();
  new DevicesView();
  keepScreenAwake(navigator, document);

  const tabs = qs('#tabs');
  const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('button'));
  const show = (name: TabName) => {
    for (const button of buttons) button.classList.toggle('active', button.dataset.tab === name);
    for (const view of Array.from(document.querySelectorAll('.view'))) {
      view.classList.toggle('active', view.id === `view-${name}`);
    }
    // the panel toggle only means something on the ride view
    qs('#toggle-sidebar').classList.toggle('hidden', name !== 'ride');
  };
  tabs.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (button?.dataset.tab) show(button.dataset.tab as TabName);
  });

  void bootDevices();

  session.on('state', (state) => {
    if (state === 'running') mock.rig.pedalling = true;
  });

  window.addEventListener('beforeunload', (e) => {
    if (session.snapshot.state === 'running' && session.snapshot.samples.length > 30) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/**
 * Bring up whatever the rider already paired. If real hardware is known, the
 * simulator stays off — two trainers both claiming the trainer role would mix
 * made-up numbers into a real ride. It is one click away in the devices panel.
 */
async function bootDevices(): Promise<void> {
  let restored: Awaited<ReturnType<typeof restorePairedDevices>> = [];
  try {
    restored = await restorePairedDevices();
  } catch (err) {
    console.warn('could not list paired Bluetooth devices', err);
  }

  for (const device of restored) hub.register(device);

  if (restored.length > 0) {
    if (!settings.current.autoConnectBle) return;
    for (const device of restored) {
      try {
        await device.connect();
      } catch {
        // Asleep, out of range, or radio off. Clear the intent so it does not
        // sit in a reconnect loop; the rider can press Connect when ready.
        await device.disconnect().catch(() => {});
      }
    }
    const connected = restored.filter((d) => d.status === 'connected');
    if (connected.length) toast(`Reconnected ${connected.map((d) => d.label).join(', ')}.`);
    return;
  }

  // The simulator is opt-in: off unless the rider asked for it in Settings.
  if (settings.current.useMockDevices) {
    registerMockDevices();
    try {
      await Promise.all([mock.trainer.connect(), mock.hrm.connect()]);
      mock.rig.pedalling = true;
    } catch (err) {
      toast(`Could not start the simulated devices: ${(err as Error).message}`, 'error');
    }
  }
}
