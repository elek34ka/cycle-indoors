import { int } from '../core/format';
import { settings } from '../core/settings';
import { hub } from '../devices/hub';
import { mock, registerMockDevices } from '../devices/setup';
import { FtmsTrainer } from '../devices/ble/ftms';
import { BlePowerMeter, BleHeartRateMonitor, BleSpeedCadenceSensor } from '../devices/ble/sensors';
import { BleDevice } from '../devices/ble/ble-device';
import {
  forgetDevice, isBluetoothAvailable, isBluetoothSupported, pairDevice,
  requiresSecureContext, type PairKind,
} from '../devices/ble/pair';
import type { Device } from '../devices/types';
import { session } from '../session/session';
import { describeSpinDown, isActive } from '../session/spin-down';
import { clear, el, qs, setClass, setText, toast } from './dom';

const ROLE_LABEL: Record<string, string> = {
  trainer: 'trainer control',
  power: 'power',
  cadence: 'cadence',
  speed: 'speed',
  heartRate: 'heart rate',
};

const STATUS_LABEL: Record<Device['status'], string> = {
  disconnected: 'not connected',
  connecting: 'connecting…',
  connected: 'connected',
  error: 'error',
};

const PAIR_BUTTONS: { kind: PairKind; label: string; title: string }[] = [
  { kind: 'trainer', label: 'Pair trainer', title: 'Smart trainers advertising the Fitness Machine Service (FTMS)' },
  { kind: 'heartRate', label: 'Pair HR strap', title: 'Any Bluetooth heart rate monitor' },
  { kind: 'power', label: 'Pair power meter', title: 'Cranks, pedals or hubs using the Cycling Power Service' },
  { kind: 'speedCadence', label: 'Pair speed / cadence', title: 'Cycling Speed and Cadence sensors' },
  { kind: 'any', label: 'Pair anything…', title: 'Show every nearby device, then work out what it offers' },
];

const LIVE_REFRESH_MS = 500;

const MOCK_IDS = ['mock-trainer', 'mock-hrm'];

interface Row {
  root: HTMLElement;
  sub: HTMLElement;
  live: HTMLElement;
  detail: HTMLElement;
  action: HTMLButtonElement;
  calibration: HTMLElement;
  calibrationText: HTMLElement;
  calibrationButton: HTMLButtonElement;
}

/** Device management lives on the Settings page; the top bar only shows status. */
export class DevicesView {
  private panel = qs('#devices-panel');
  private chips = qs('#device-chips');
  private list!: HTMLElement;
  private sources!: HTMLElement;
  private rows = new Map<string, Row>();
  private simButton!: HTMLButtonElement;
  private lastChipRender = 0;

  constructor() {
    this.buildPanel();
    hub.on('devices', () => { this.syncRows(); this.renderChips(true); });
    hub.on('telemetry', () => this.renderChips(false));
    // Calibration steps should not wait for the next refresh to show.
    session.on('calibration', () => this.refreshLive());
    session.on('state', () => this.refreshLive());
    window.setInterval(() => this.refreshLive(), LIVE_REFRESH_MS);
    this.syncRows();
    this.renderChips(true);
    void this.describeBluetooth();
  }

  // ---- top bar chips -------------------------------------------------------

  private renderChips(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastChipRender < 250) return;
    this.lastChipRender = now;

    const snapshot = hub.snapshot();
    const trainer = hub.trainer;
    const hr = hub.connected('heartRate')[0];

    const spec = [
      {
        label: trainer?.status === 'connected' ? `${int(snapshot.power)} W` : 'No trainer',
        state: trainer?.status ?? 'disconnected',
      },
      {
        label: hr && snapshot.heartRate !== undefined ? `${int(snapshot.heartRate)} bpm` : 'No HR',
        state: hr?.status ?? 'disconnected',
      },
    ];

    if (this.chips.children.length !== spec.length) {
      clear(this.chips);
      for (const _ of spec) {
        this.chips.append(el('div', { class: 'chip', title: 'Manage devices on the Settings page' }, [
          el('div', { class: 'dot' }), el('span'),
        ]));
      }
    }

    Array.from(this.chips.children).forEach((node, i) => {
      const s = spec[i];
      setText(node.lastElementChild!, s.label);
      setClass(node, 'on', s.state === 'connected');
      setClass(node, 'pending', s.state === 'connecting');
      setClass(node, 'err', s.state === 'error');
    });
  }

  // ---- panel ---------------------------------------------------------------

  private buildPanel(): void {
    clear(this.panel);
    this.list = el('div', { class: 'device-list' });
    this.sources = el('div', { class: 'source-summary' });

    const pairRow = el('div', { class: 'pair-row' });
    for (const button of PAIR_BUTTONS) {
      pairRow.append(el('button', {
        class: button.kind === 'trainer' ? 'btn btn-small btn-primary' : 'btn btn-small',
        text: button.label,
        title: button.title,
        on: { click: (e) => void this.pair(button.kind, e.currentTarget as HTMLButtonElement) },
      }));
    }

    this.panel.append(
      el('h2', { text: 'Devices' }),
      el('p', { class: 'hint', id: 'ble-status', text: 'Checking Bluetooth…' }),
      pairRow,
      this.list,
      el('div', { class: 'phase-note' }, [
        el('strong', { text: 'Trainer control is live. ' }),
        document.createTextNode(
          'A trainer that reports a power target takes ERG watts from the workout; '
          + 'one that reports simulation support takes the gradient in free mode. '
          + 'Each row says whether this app currently holds control of the brake.',
        ),
      ]),
      this.sources,
      this.buildSimulatorSection(),
    );
  }

  /** The simulated rider is a development aid, so it is folded away and off by
   *  default — it must never be mistaken for a real sensor. */
  private buildSimulatorSection(): HTMLElement {
    this.simButton = el('button', { class: 'btn btn-small' }) as HTMLButtonElement;
    this.simButton.addEventListener('click', () => void this.toggleSimulator());

    return el('details', { class: 'sim-disclosure' }, [
      el('summary', { text: 'Simulator' }),
      el('p', {
        class: 'hint',
        text: 'A simulated trainer and heart-rate strap, for trying the app out '
          + 'without hardware. Its numbers are invented — turn it off before a real ride.',
      }),
      el('div', { class: 'device-actions' }, [this.simButton]),
    ]);
  }

  private simulatorActive(): boolean {
    return MOCK_IDS.some((id) => hub.find(id) !== undefined);
  }

  private async toggleSimulator(): Promise<void> {
    this.simButton.disabled = true;
    try {
      if (this.simulatorActive()) {
        for (const id of MOCK_IDS) await hub.unregister(id);
        settings.patch({ useMockDevices: false });
        toast('Simulated devices removed.');
      } else {
        registerMockDevices();
        settings.patch({ useMockDevices: true });
        await Promise.all([mock.trainer.connect(), mock.hrm.connect()]);
        mock.rig.pedalling = true;
        toast('Simulated trainer and strap connected.');
      }
    } catch (err) {
      toast(`Simulator: ${(err as Error).message}`, 'error');
    } finally {
      this.simButton.disabled = false;
      this.syncRows();
    }
  }

  private async describeBluetooth(): Promise<void> {
    const node = qs('#ble-status');
    if (!isBluetoothSupported()) {
      setText(node, 'This browser has no Web Bluetooth. Use Chrome, Edge or another Chromium browser to pair real sensors.');
      node.classList.add('hint-warn');
      return;
    }
    if (requiresSecureContext()) {
      setText(node, 'Bluetooth needs a secure context. Open the app over https, or on localhost.');
      node.classList.add('hint-warn');
      return;
    }
    const available = await isBluetoothAvailable();
    setText(node, available
      ? 'Pair a sensor below — each opens your browser’s own device chooser. Where the browser supports listing granted devices, they reconnect on load; otherwise pick the sensor again from the chooser.'
      : 'Web Bluetooth is available but no radio was found — switch Bluetooth on, then pair below.');
    setClass(node, 'hint-warn', !available);
  }

  private async pair(kind: PairKind, button: HTMLButtonElement): Promise<void> {
    const original = button.textContent ?? '';
    button.disabled = true;
    button.textContent = 'Choosing…';
    try {
      const { device } = await pairDevice(kind);
      if (hub.find(device.id)) {
        toast(`${device.label} is already paired.`);
        return;
      }
      hub.register(device);
      this.syncRows();
      button.textContent = 'Connecting…';
      await device.connect();
      this.retireMockFor(device);
      toast(`${device.label} connected.`);
    } catch (err) {
      const message = (err as Error).message;
      // Dismissing the chooser is a normal outcome, not a failure worth shouting about.
      if ((err as Error).name === 'NotFoundError' && /user|cancel/i.test(message)) return;
      toast(message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = original;
      this.syncRows();
    }
  }

  /** A real trainer and the simulator both claim the trainer role; the real one wins. */
  private retireMockFor(device: Device): void {
    if (!device.roles.includes('trainer')) return;
    if (mock.trainer.status !== 'connected') return;
    void mock.trainer.disconnect();
    toast('Simulated trainer switched off — your real trainer is in charge now.');
  }

  private syncRows(): void {
    const devices = hub.list();
    for (const [id, row] of this.rows) {
      if (!devices.some((d) => d.id === id)) {
        row.root.remove();
        this.rows.delete(id);
      }
    }
    for (const device of devices) {
      if (!this.rows.has(device.id)) this.rows.set(device.id, this.buildRow(device));
    }
    if (devices.length === 0 && !this.list.querySelector('.empty')) {
      this.list.append(el('div', { class: 'empty', text: 'No devices yet — pair one above.' }));
    } else if (devices.length > 0) {
      this.list.querySelector('.empty')?.remove();
    }
    this.refreshLive();
  }

  private buildRow(device: Device): Row {
    const sub = el('div', { class: 'sub' });
    const live = el('div', { class: 'live' });
    const detail = el('div', { class: 'detail' });
    const action = el('button', { class: 'btn btn-small' }) as HTMLButtonElement;
    action.addEventListener('click', () => void this.toggleDevice(device, action));

    const buttons: HTMLElement[] = [action];
    if (device.transport === 'ble') {
      buttons.push(el('button', {
        class: 'btn btn-small btn-ghost',
        text: 'Forget',
        title: 'Remove this device from the app (browser permission stays until you revoke it in site settings)',
        on: {
          click: async () => {
            forgetDevice(device.id.replace(/^ble:/, ''));
            await hub.unregister(device.id);
            toast(`${device.label} removed.`);
          },
        },
      }));
    }

    // One button whose job follows the calibration: Calibrate, Cancel, Dismiss.
    const calibrationText = el('span', { class: 'calibration-text' });
    const calibrationButton = el('button', { class: 'btn btn-small' }) as HTMLButtonElement;
    calibrationButton.addEventListener('click', () => this.calibrationAction());
    const calibration = el('div', { class: 'calibration' }, [calibrationButton, calibrationText]);
    calibration.hidden = true;

    const root = el('div', { class: 'device-row' }, [
      el('div', {}, [
        el('div', { class: 'name', text: device.label }),
        sub,
        detail,
        live,
        calibration,
      ]),
      el('div', { class: 'device-row-actions' }, buttons),
    ]);
    this.list.append(root);
    return { root, sub, live, detail, action, calibration, calibrationText, calibrationButton };
  }

  private calibrationAction(): void {
    const phase = session.calibration.phase;
    if (isActive(session.calibration)) session.cancelCalibration();
    else if (phase === 'succeeded' || phase === 'failed') session.dismissCalibration();
    else session.calibrate().catch((err) => toast((err as Error).message, 'error'));
  }

  /** Only the trainer in charge, only while connected, and only if it says it
   *  can spin down — the simulated trainer never does. */
  private renderCalibration(device: Device, row: Row, speed: number | undefined): void {
    const offered = device === hub.trainer && device.status === 'connected'
      && device.control?.spinDown !== undefined;
    row.calibration.hidden = !offered;
    if (!offered) return;

    const state = session.calibration;
    const phase = state.phase;
    setClass(row.calibration, 'calibration-ok', phase === 'succeeded');
    setClass(row.calibration, 'calibration-error', phase === 'failed');

    if (phase === 'idle') {
      const allowed = session.canCalibrate;
      setText(row.calibrationButton, 'Calibrate');
      row.calibrationButton.disabled = !allowed;
      row.calibrationButton.title = allowed
        ? 'Spin-down calibration: speed up, then coast while the trainer measures itself'
        : 'Finish the ride first';
      setText(row.calibrationText, allowed ? '' : 'Finish the ride first to calibrate');
      return;
    }
    row.calibrationButton.disabled = false;
    row.calibrationButton.title = '';
    setText(row.calibrationButton, isActive(state) ? 'Cancel' : 'Dismiss');
    setText(row.calibrationText, describeSpinDown(state, speed));
  }

  private async toggleDevice(device: Device, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      if (device.status === 'connected') await device.disconnect();
      else {
        await device.connect();
        this.retireMockFor(device);
      }
    } catch (err) {
      toast(`${device.label}: ${(err as Error).message}`, 'error');
    } finally {
      button.disabled = false;
      this.refreshLive();
    }
  }

  /** Status, battery and live numbers, without rebuilding the rows. */
  private refreshLive(): void {
    const snapshot = hub.snapshot();
    for (const device of hub.list()) {
      const row = this.rows.get(device.id);
      if (!row) continue;

      const bits = [STATUS_LABEL[device.status], device.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')];
      if (device.battery !== undefined) bits.push(`battery ${device.battery}%`);
      setText(row.sub, bits.join(' · '));
      // A failed pairing should leave its reason on screen, not only in a toast.
      const failure = device instanceof BleDevice && device.status !== 'connected' ? device.lastError : undefined;
      setText(row.detail, failure ? `${describe(device)}${describe(device) ? ' · ' : ''}${failure}` : describe(device));
      setClass(row.detail, 'detail-error', Boolean(failure));
      setClass(row.root, 'is-connected', device.status === 'connected');
      setClass(row.root, 'is-error', device.status === 'error');

      const live = device.status === 'connected'
        ? [
            hub.sourceOf('power') === device ? `${int(snapshot.power)} W` : null,
            hub.sourceOf('cadence') === device ? `${int(snapshot.cadence)} rpm` : null,
            hub.sourceOf('speed') === device ? `${int(snapshot.speed)} km/h` : null,
            hub.sourceOf('heartRate') === device ? `${int(snapshot.heartRate)} bpm` : null,
          ].filter(Boolean).join('  ·  ')
        : '';
      setText(row.live, live);

      setText(row.action, device.status === 'connected' ? 'Disconnect' : device.status === 'connecting' ? '…' : 'Connect');
      setClass(row.action, 'btn-primary', device.status !== 'connected' && device.status !== 'connecting');
      row.action.disabled = device.status === 'connecting';
      this.renderCalibration(device, row, snapshot.speed);
    }

    setText(this.simButton, this.simulatorActive()
      ? 'Remove simulated devices'
      : 'Add simulated trainer + strap');

    clear(this.sources);
    const metrics = [
      ['Power', hub.sourceOf('power')],
      ['Heart rate', hub.sourceOf('heartRate')],
      ['Cadence', hub.sourceOf('cadence')],
      ['Speed', hub.sourceOf('speed')],
    ] as const;
    if (metrics.some(([, device]) => device)) {
      this.sources.append(el('div', { class: 'panel-head', text: 'Reading from' }));
      for (const [label, device] of metrics) {
        this.sources.append(el('div', { class: 'row' }, [
          el('span', { text: label }),
          el('strong', { text: device?.label ?? '—' }),
        ]));
      }
    }
  }
}

/** The per-device extra line: what a trainer can be told to do, where a strap sits. */
function describe(device: Device): string {
  if (device instanceof FtmsTrainer) {
    const parts = [device.describeControl()];
    if (device.powerRange) parts.push(`${device.powerRange.min}–${device.powerRange.max} W`);
    if (device.status === 'connected') parts.push(device.describeControlState());
    const last = device.lastControlResult;
    if (last) parts.push(last);
    if (device.lastMachineStatus) parts.push(device.lastMachineStatus);
    return parts.join(' · ');
  }
  if (device instanceof BleHeartRateMonitor) {
    const parts: string[] = [];
    if (device.location) parts.push(`worn on the ${device.location}`);
    if (device.contactDetected === false) parts.push('no skin contact');
    return parts.join(' · ');
  }
  if (device instanceof BlePowerMeter || device instanceof BleSpeedCadenceSensor) {
    const parts: string[] = [];
    if (device.reportsCadence) parts.push('reports crank revolutions');
    if (device.reportsWheel) parts.push(`wheel ${settings.current.wheelCircumference} mm`);
    return parts.join(' · ');
  }
  if (device instanceof BleDevice) {
    return [device.identity.manufacturer, device.identity.model].filter(Boolean).join(' ');
  }
  return '';
}
