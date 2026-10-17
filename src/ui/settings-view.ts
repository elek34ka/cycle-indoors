import { settings, type Settings } from '../core/settings';
import { el, qs, toast } from './dom';

interface ToggleSpec { key: keyof Settings; label: string; hint: string; }

const TOGGLES: ToggleSpec[] = [
  {
    key: 'useMockDevices',
    label: 'Simulated trainer and strap',
    hint: 'Off by default. Connects an invented trainer and strap on load, for trying the app out without hardware.',
  },
  {
    key: 'autoConnectBle',
    label: 'Reconnect Bluetooth devices on load',
    hint: 'Reconnects sensors you have already paired, without opening the chooser again.',
  },
  {
    key: 'showMiniMap',
    label: 'Show the route map',
    hint: 'The small map in the corner of the ride screen — shown only when a route is loaded. Press M to toggle it while riding.',
  },
  {
    key: 'miniMapFollow',
    label: 'Keep the map centred on you',
    hint: 'Follows your position at close zoom. There is a Follow switch inside the map too.',
  },
];

interface FieldSpec {
  key: keyof Settings;
  label: string;
  min: number;
  max: number;
  step?: number;
  suffix: string;
}

const FIELDS: FieldSpec[] = [
  { key: 'ftp', label: 'FTP', min: 50, max: 600, suffix: 'watts — every % target is derived from this' },
  { key: 'hrMax', label: 'Max heart rate', min: 100, max: 230, suffix: 'bpm — used for HR zones' },
  { key: 'riderWeight', label: 'Rider weight', min: 30, max: 160, step: 0.5, suffix: 'kg' },
  { key: 'bikeWeight', label: 'Bike weight', min: 3, max: 25, step: 0.1, suffix: 'kg' },
  { key: 'smoothPowerSeconds', label: 'Power smoothing', min: 0, max: 30, suffix: 'seconds shown on the dashboard' },
  { key: 'wheelCircumference', label: 'Wheel circumference', min: 1000, max: 2500, suffix: 'mm — for wheel-based speed sensors (phase 2)' },
];

export function buildSettingsView(): void {
  const host = qs('#settings-form');
  host.append(
    el('h2', { text: 'Rider profile' }),
    el('p', { class: 'hint', text: 'Stored in this browser only. A real account and sync arrive with the backend.' }),
  );

  const grid = el('div', { class: 'field-grid' });
  for (const field of FIELDS) {
    const input = el('input', {
      type: 'number',
      min: String(field.min),
      max: String(field.max),
      step: String(field.step ?? 1),
      value: String(settings.current[field.key]),
    }) as HTMLInputElement;

    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < field.min || value > field.max) {
        input.value = String(settings.current[field.key]);
        toast(`${field.label} must be between ${field.min} and ${field.max}`, 'error');
        return;
      }
      settings.patch({ [field.key]: value } as Partial<Settings>);
    });

    grid.append(el('div', { class: 'field' }, [
      el('label', { text: field.label }),
      input,
      el('div', { class: 'suffix', text: field.suffix }),
    ]));
  }
  host.append(grid);

  const toggles = el('div', { class: 'toggle-list' });
  for (const toggle of TOGGLES) {
    const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = Boolean(settings.current[toggle.key]);
    input.addEventListener('change', () => {
      settings.patch({ [toggle.key]: input.checked } as unknown as Partial<Settings>);
    });
    toggles.append(el('label', { class: 'toggle-row' }, [
      input,
      el('div', {}, [
        el('div', { class: 'toggle-label', text: toggle.label }),
        el('div', { class: 'suffix', text: toggle.hint }),
      ]),
    ]));
  }
  host.append(toggles);

  host.append(el('div', { class: 'summary-actions' }, [
    el('button', {
      class: 'btn',
      text: 'Reset to defaults',
      on: {
        click: () => {
          settings.reset();
          const numbers = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="number"]'));
          numbers.forEach((input, i) => {
            const field = FIELDS[i];
            if (field) input.value = String(settings.current[field.key]);
          });
          const checks = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
          checks.forEach((input, i) => {
            const toggle = TOGGLES[i];
            if (toggle) input.checked = Boolean(settings.current[toggle.key]);
          });
          toast('Settings reset.');
        },
      },
    }),
  ]));
}
