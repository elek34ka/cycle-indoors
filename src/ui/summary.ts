import { fileStamp, hhmmss, km, stamp } from '../core/format';
import { settings } from '../core/settings';
import { riderZones } from '../core/zones';
import { buildActivityFit, downloadBlob, downloadBytes } from '../activity/fit-export';
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
import { stravaDescription } from '../activity/strava-description';
import { subText, summaryValues } from './summary-values';
import { ProfileGraph } from './profile-graph';
import { ElevationGraph } from './elevation-graph';
import type { Course } from '../activity/course';
import type { RideMetrics, ZoneTime } from '../session/metrics';
import { renderGraphImage, renderStatsImage, type ImageHeader } from './summary-image';

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

/** The open summary's graphs, disposed before the next summary replaces them. */
let openGraphs: { dispose(): void }[] = [];

/** The line above a finished route ride's profile: where, how far, how much climbing. */
export function profileHeader(routeName: string, distance: number, ascent: number): string {
  return `${routeName} · ${km(distance)} km · ↑ ${Math.round(ascent)} m`;
}

/** The whole ride on the workout graph, and the route's profile under it when it has one. */
function rideGraphs(snapshot: SessionSnapshot, course: Course | undefined, distance: number, ascent: number): HTMLElement {
  const lastT = snapshot.samples.at(-1)?.t ?? 0;
  const finished = { ...snapshot, elapsed: Math.max(snapshot.elapsed || 0, lastT) };

  const graphCanvas = el('canvas') as HTMLCanvasElement;
  const graphHost = el('div', { class: 'summary-graph' }, [graphCanvas]);
  const host = el('div', { class: 'summary-graphs' }, [graphHost]);
  if (course?.hasElevation) {
    const profileCanvas = el('canvas') as HTMLCanvasElement;
    host.append(el('div', { class: 'summary-elevation' }, [profileCanvas]));
  }
  // The graphs size themselves from their hosts, so build them once the hosts exist.
  const graph = new ProfileGraph(graphCanvas, { mode: 'whole' });
  graph.setWorkout(snapshot.workout);
  graph.render(finished);
  openGraphs.push(graph);
  const profileCanvas = host.querySelector<HTMLCanvasElement>('.summary-elevation canvas');
  if (course && profileCanvas) {
    const profile = new ElevationGraph(profileCanvas);
    profile.setCourse(course);
    profile.setFinished(distance, profileHeader(course.name, distance, ascent));
    openGraphs.push(profile);
  }
  return host;
}

/** Time in each zone as bars, under a title; `empty` replaces the bars when there is nothing to show. */
function zoneChart(title: string, zones: readonly ZoneTime[], empty?: string): HTMLElement {
  const longest = Math.max(1, ...zones.map((z) => z.seconds));
  return el('section', { class: 'zone-chart' }, [
    el('h3', { text: title }),
    empty
      ? el('p', { class: 'empty', text: empty })
      : el('div', { class: 'zone-bars' }, zones.map((z) => el('div', { class: 'zone-row' }, [
        el('div', { text: `Z${z.zone} ${z.label}` }),
        el('div', { class: 'track' }, [(() => {
          const fill = el('div', { class: 'fill' });
          fill.style.width = `${(z.seconds / longest) * 100}%`;
          fill.style.background = z.color;
          return fill;
        })()]),
        el('div', { class: 'time', text: hhmmss(z.seconds) }),
      ]))),
  ]);
}

export const NO_HEART_RATE = 'No heart rate recorded';

export const IMAGES_NOTE = 'Add these to the activity on Strava by hand: Strava does not accept images from apps.';

/** Save graph image and Save stats image, each a PNG named after the ride like its `.fit`. */
function imageRow(
  baseName: string,
  header: ImageHeader,
  snapshot: SessionSnapshot,
  metrics: RideMetrics,
  ftp: number,
  course: Course | undefined,
): HTMLElement {
  const lastT = snapshot.samples.at(-1)?.t ?? 0;
  const save = (text: string, suffix: string, render: () => Promise<Blob | null>) => {
    const button = el('button', {
      class: 'btn',
      text,
      on: {
        click: async () => {
          button.disabled = true;
          try {
            const blob = await render().catch(() => null);
            if (!blob) {
              toast('Could not save the image: this browser did not produce one.', 'error');
              return;
            }
            downloadBlob(blob, `${baseName}-${suffix}.png`);
          } finally {
            button.disabled = false;
          }
        },
      },
    }) as HTMLButtonElement;
    return button;
  };
  const values = summaryValues(metrics, snapshot.laps.length);
  return el('div', { class: 'summary-images' }, [
    save('Save graph image', 'graph', () => renderGraphImage({
      header,
      graph: {
        workout: snapshot.workout,
        samples: snapshot.samples,
        elapsed: Math.max(snapshot.elapsed || 0, lastT),
        ftp,
        hrMax: settings.current.hrMax,
        powerZones: riderZones(settings.current).power,
        smoothWindow: settings.current.smoothPowerSeconds,
      },
      ...(course?.hasElevation ? {
        profile: { course, ridden: metrics.distance, header: profileHeader(course.name, metrics.distance, metrics.ascent) },
      } : {}),
    })),
    save('Save stats image', 'stats', () => renderStatsImage({
      header,
      values,
      zones: metrics.zones,
      hrZones: metrics.hrZones,
      ...(metrics.avgHr === undefined ? { hrEmpty: NO_HEART_RATE } : {}),
    })),
    el('span', { class: 'summary-images-note', text: IMAGES_NOTE }),
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
  for (const graph of openGraphs) graph.dispose();
  openGraphs = [];
  clear(overlay);

  const ftp = snapshot.workout?.ftpOverride ?? settings.current.ftp;
  const samples = [...snapshot.samples];
  // The zones in Settings at Finish measure the whole ride, edits made mid-ride included.
  const metrics = computeMetrics(samples, ftp, settings.current.hrMax, riderZones(settings.current));
  const title = snapshot.workout?.name ?? 'Free ride';
  const startedAt = session.startedAt ?? new Date();
  // What was ridden is what was loaded when the summary opened, whatever is loaded later.
  const course = courseStore.current;

  if (personal) {
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

  const subtitle = `${stamp(startedAt)} · ${metrics.duration ? hhmmss(metrics.duration) : 'nothing recorded'} · FTP ${ftp} W`;
  card.append(el('header', {}, [
    el('h2', { text: title }),
    el('p', { text: subtitle }),
  ]));
  const baseName = `cycle-indoors-${fileStamp(startedAt)}`;

  if (samples.length === 0) {
    card.append(el('p', { class: 'empty', text: 'No data was recorded for this ride.' }));
  } else {
    card.append(rideGraphs(snapshot, course, metrics.distance, metrics.ascent));
    card.append(el('div', { class: 'summary-grid' },
      summaryValues(metrics, snapshot.laps.length).map((v) => cell(v.label, v.value, subText(v)))));
    card.append(el('div', { class: 'zone-charts' }, [
      zoneChart('Power zones', metrics.zones),
      zoneChart('Heart-rate zones', metrics.hrZones, metrics.avgHr === undefined ? NO_HEART_RATE : undefined),
    ]));
    const header = { title, subtitle, ...(course ? { route: `Route: ${course.name}` } : {}) };
    card.append(imageRow(baseName, header, snapshot, metrics, ftp, course));
  }

  const fileName = `${baseName}.fit`;
  // Built now, so an upload later still describes what was ridden, whatever is loaded by then.
  const description = stravaDescription({
    ...(course ? { route: course.name } : {}),
    ...(snapshot.workout ? { workout: snapshot.workout.name } : {}),
    values: summaryValues(metrics, snapshot.laps.length),
    ...(metrics.maxHr !== undefined ? { maxHr: Math.round(metrics.maxHr) } : {}),
    zones: metrics.zones,
    hrZones: metrics.hrZones,
  });
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
    samples.length > 0 ? stravaButton(startedAt, () => ({ bytes: buildFit(), name: title, fileName, description }), personal) : null,
    download,
  ]));

  overlay.append(card);
  overlay.classList.remove('hidden');
}

/** What an upload sends: the `.fit`, its name and file name, and the description. */
interface RideUpload { bytes: Uint8Array; name: string; fileName: string; description: string }

/**
 * Upload to Strava, or a link to the activity once it is there. With
 * auto-upload on and a connection already in place, the upload starts as soon
 * as the summary opens; it never opens Strava's pop-up by itself.
 */
function stravaButton(
  startedAt: Date,
  ride: () => RideUpload,
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
  ride: () => RideUpload,
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
    const { bytes, name, fileName, description } = ride();
    const result = await strava.upload(bytes, { name, description, externalId: fileName }, (busy) => set({ busy }));
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
