import { dec, fileStamp, hhmmss, int, km, stamp } from '../core/format';
import { settings } from '../core/settings';
import { buildActivityFit, downloadBytes } from '../activity/fit-export';
import { computeMetrics } from '../session/metrics';
import { session, type SessionSnapshot } from '../session/session';
import { strava, StravaNotConnected, type UploadResult } from '../activity/strava';
import { clear, el, qs, toast } from './dom';
import { confirmDialog } from './confirm';
import { connectStrava } from './strava-panel';
import { entryFor, routeEntryFor, type LoadedEntry } from '../library/loaded';
import type { PersonalLibrary } from '../library/personal';
import { courseStore } from '../activity/course-store';
import { rideLogEntry } from '../ride-log/entry';

/** Strava uploads by ride start time, so reopening a summary neither repeats
 *  an upload nor loses track of one still in flight. */
interface UploadState { result?: UploadResult; busy?: string }
const uploads = new Map<number, UploadState>();
/** every rendered button for a ride, so whichever summary is open shows progress */
const uploadViews = new Map<number, Set<() => void>>();

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

/** Offers to mark the ridden workout done. Never marks it by itself: the
 *  rider decides, whether or not the workout ran to its end. */
function markDoneRow(entry: LoadedEntry, personal: PersonalLibrary): HTMLElement {
  const button = el('button', {
    class: 'btn summary-mark-done',
    text: `Mark "${entry.title}" as done`,
    on: {
      click: async () => {
        button.disabled = true;
        try {
          await personal.setDone(entry.key, true);
          button.textContent = `"${entry.title}" is marked done`;
        } catch (err) {
          button.disabled = false;
          toast(`Could not save the done mark: ${(err as Error).message}`, 'error');
        }
      },
    },
  }) as HTMLButtonElement;
  const note = el('span', { class: 'summary-done-note' });
  void personal.available().then((ok) => {
    if (ok) return;
    button.disabled = true;
    note.textContent = 'Done marks cannot be saved in this browser.';
  });
  return el('div', { class: 'summary-done' }, [button, note]);
}

export function showSummary(snapshot: SessionSnapshot, personal?: PersonalLibrary): void {
  const overlay = qs('#summary-overlay');
  clear(overlay);

  const ftp = snapshot.workout?.ftpOverride ?? settings.current.ftp;
  const samples = [...snapshot.samples];
  const metrics = computeMetrics(samples, ftp);
  const title = snapshot.workout?.name ?? 'Free ride';
  const startedAt = session.startedAt ?? new Date();

  if (personal) {
    const course = courseStore.current;
    const logged = rideLogEntry({
      startedAt,
      metrics,
      ...(snapshot.workout ? { workout: { title, entry: entryFor(snapshot.workout) } } : {}),
      ...(course ? { route: { name: course.name, entry: routeEntryFor(course) } } : {}),
    });
    // Keyed by start time, so a summary shown again logs the same ride once.
    if (logged) void personal.logRide(logged);
  }

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

  const fileName = `cycle-indoors-${fileStamp(startedAt)}.fit`;
  const buildFit = () => buildActivityFit({ startedAt, samples, laps: snapshot.laps, metrics, name: title });

  const download = el('button', {
    class: 'btn btn-primary',
    text: 'Download .fit',
    disabled: samples.length === 0,
    on: {
      click: () => {
        try {
          const bytes = buildFit();
          downloadBytes(bytes, fileName);
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

  const entry = entryFor(snapshot.workout);
  if (entry && personal) card.append(markDoneRow(entry, personal));

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
              message: `${hhmmss(metrics.duration)} of riding has not been downloaded or uploaded. `
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
    samples.length > 0 ? stravaButton(startedAt, () => ({ bytes: buildFit(), name: title, fileName }), personal) : null,
    download,
  ]));

  overlay.append(card);
  overlay.classList.remove('hidden');
}

/**
 * Upload to Strava, or a link to the activity once it is there. With
 * auto-upload on and a connection already in place, the upload starts as soon
 * as the summary opens; it never opens Strava's pop-up by itself.
 */
function stravaButton(
  startedAt: Date,
  ride: () => { bytes: Uint8Array; name: string; fileName: string },
  personal?: PersonalLibrary,
): HTMLElement {
  const key = startedAt.getTime();
  const slot = el('span', { class: 'strava-slot' });

  const render = () => {
    clear(slot);
    const state = uploads.get(key);
    const result = state?.result;
    if (result && result.kind !== 'processing' && result.url) {
      slot.append(el('a', {
        class: 'btn',
        text: result.kind === 'duplicate' ? 'Already on Strava' : 'View on Strava',
        attrs: { href: result.url, target: '_blank', rel: 'noopener' },
      }));
    } else if (result) {
      slot.append(el('button', { class: 'btn', text: 'Sent to Strava', disabled: true }));
    } else {
      slot.append(el('button', {
        class: 'btn',
        text: state?.busy ?? 'Upload to Strava',
        disabled: Boolean(state?.busy),
        on: { click: () => void uploadRide(key, ride, true, personal) },
      }));
    }
  };

  let views = uploadViews.get(key);
  if (!views) uploadViews.set(key, views = new Set());
  // Only the open summary needs telling; one replaced by a newer summary is dropped.
  for (const view of [...views]) views.delete(view);
  views.add(render);
  render();

  if (settings.current.stravaAutoUpload && strava.status === 'connected' && !uploads.has(key)) {
    void uploadRide(key, ride, false, personal);
  }
  return slot;
}

async function uploadRide(
  key: number,
  ride: () => { bytes: Uint8Array; name: string; fileName: string },
  fromClick: boolean,
  personal?: PersonalLibrary,
): Promise<void> {
  if (uploads.has(key)) return;
  const set = (state: UploadState | undefined) => {
    if (state) uploads.set(key, state); else uploads.delete(key);
    uploadViews.get(key)?.forEach((render) => render());
  };
  // Connecting opens a pop-up, which browsers only allow from a click.
  if (strava.status !== 'connected' && !(fromClick && (await connectStrava()))) return;
  if (uploads.has(key)) return;

  set({ busy: 'Uploading…' });
  try {
    const { bytes, name, fileName } = ride();
    const result = await strava.upload(bytes, { name, externalId: fileName }, (busy) => set({ busy }));
    set({ result });
    // The ride log links to the activity, whether new or one Strava already had.
    if (result.kind !== 'processing' && result.activityId !== undefined) void personal?.setRideStrava(key, result.activityId);
    // Safe on Strava, so discarding the ride no longer loses it.
    if (session.startedAt?.getTime() === key) session.markExported();
    toast(result.kind === 'created' ? 'Uploaded to Strava.'
      : result.kind === 'duplicate' ? 'This ride is already on Strava.'
      : 'Sent to Strava. It is still processing and will appear in your feed shortly.');
  } catch (err) {
    set(undefined);
    toast(err instanceof StravaNotConnected
      ? `${err.message} Then press Upload to Strava.`
      : `Upload to Strava failed: ${(err as Error).message}`, 'error');
  }
}
