import { dec, fileStamp, hhmmss, int, km, stamp } from '../core/format';
import { settings } from '../core/settings';
import { buildActivityFit, downloadBytes } from '../activity/fit-export';
import { computeMetrics } from '../session/metrics';
import { session, type SessionSnapshot } from '../session/session';
import { clear, el, qs, toast } from './dom';
import { confirmDialog } from './confirm';

function cell(label: string, value: string, note?: string): HTMLElement {
  return el('div', { class: 'cell' }, [
    el('span', { text: label }),
    el('strong', { text: value }),
    note ? el('em', { text: note }) : null,
  ]);
}

export function hideSummary(): void {
  qs('#summary-overlay').classList.add('hidden');
}

export function showSummary(snapshot: SessionSnapshot): void {
  const overlay = qs('#summary-overlay');
  clear(overlay);

  const ftp = snapshot.workout?.ftpOverride ?? settings.current.ftp;
  const samples = [...snapshot.samples];
  const metrics = computeMetrics(samples, ftp);
  const title = snapshot.workout?.name ?? 'Free ride';
  const startedAt = session.startedAt ?? new Date();

  const card = el('div', { class: 'summary-card' });

  card.append(el('header', {}, [
    el('h2', { text: title }),
    el('p', { text: `${stamp(startedAt)} · ${metrics.duration ? hhmmss(metrics.duration) : 'nothing recorded'} · FTP ${ftp} W` }),
  ]));

  if (samples.length === 0) {
    card.append(el('p', { class: 'empty', text: 'No data was recorded for this ride.' }));
  } else {
    card.append(el('div', { class: 'summary-grid' }, [
      cell('Duration', hhmmss(metrics.duration)),
      cell('Distance', `${km(metrics.distance)}`, 'km'),
      cell('Avg power', int(metrics.avgPower), 'W'),
      cell('Normalised', int(metrics.normalisedPower), 'W'),
      cell('Max power', int(metrics.maxPower), 'W'),
      cell('Intensity', dec(metrics.intensityFactor, 2), 'IF'),
      cell('TSS', int(metrics.tss)),
      cell('Work', int(metrics.work), 'kJ'),
      cell('Avg HR', int(metrics.avgHr), metrics.maxHr ? `max ${Math.round(metrics.maxHr)}` : undefined),
      cell('Avg cadence', int(metrics.avgCadence), 'rpm'),
      cell('Avg speed', dec(metrics.avgSpeed, 1), 'km/h'),
      metrics.hasPosition
        ? cell('Climbed', int(metrics.ascent), `${Math.round(metrics.descent)} m down`)
        : null,
      metrics.compliance === undefined
        ? cell('Laps', String(Math.max(1, snapshot.laps.length)))
        : cell('On target', `${Math.round(metrics.compliance)}%`, 'vs. workout'),
    ].filter((node): node is HTMLElement => node !== null)));

    const longest = Math.max(1, ...metrics.zones.map((z) => z.seconds));
    card.append(el('div', { class: 'zone-bars' }, metrics.zones.map((z) => el('div', { class: 'zone-row' }, [
      el('div', { text: `Z${z.zone} ${z.label}` }),
      el('div', { class: 'track' }, [(() => {
        const fill = el('div', { class: 'fill' });
        fill.style.width = `${(z.seconds / longest) * 100}%`;
        fill.style.background = z.color;
        return fill;
      })()]),
      el('div', { class: 'time', text: hhmmss(z.seconds) }),
    ]))));
  }

  const download = el('button', {
    class: 'btn btn-primary',
    text: 'Download .fit',
    disabled: samples.length === 0,
    on: {
      click: () => {
        try {
          const bytes = buildActivityFit({ startedAt, samples, laps: snapshot.laps, metrics, name: title });
          downloadBytes(bytes, `cycle-indoors-${fileStamp(startedAt)}.fit`);
          // The ride can now be discarded without losing it.
          session.markExported();
          toast('FIT file downloaded — upload it to Strava or intervals.icu.');
          if (metrics.hasPosition) toast('The file carries the route’s GPS track, so it will show a map.');
        } catch (err) {
          toast(`Could not build the FIT file: ${(err as Error).message}`, 'error');
        }
      },
    },
  });

  card.append(el('div', { class: 'summary-actions' }, [
    el('button', { class: 'btn btn-ghost', text: 'Keep ride open', on: { click: hideSummary } }),
    el('button', {
      class: 'btn',
      text: 'New ride',
      on: {
        click: async () => {
          if (samples.length > 0 && !session.exported) {
            const confirmed = await confirmDialog({
              title: 'Discard this ride?',
              message: `${hhmmss(metrics.duration)} of riding has not been downloaded. `
                + 'Starting a new ride will throw it away.',
              confirmText: 'Discard and start new',
              cancelText: 'Keep this ride',
              danger: true,
            });
            if (!confirmed) return;
          }
          session.reset();
          hideSummary();
        },
      },
    }),
    download,
  ]));

  overlay.append(card);
  overlay.classList.remove('hidden');
}
