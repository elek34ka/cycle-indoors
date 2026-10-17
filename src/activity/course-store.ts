import { Emitter } from '../core/pubsub';
import { Course } from './course';
import type { ActivityTrack } from './types';

/** The route currently loaded for the ride: drives the mini-map, the elevation
 *  profile, the live ascent readout and (optionally) free-mode gradient. */
class CourseStore extends Emitter<{ course: Course | undefined }> {
  private value: Course | undefined;
  private lastTrack: ActivityTrack | undefined;

  get current(): Course | undefined { return this.value; }
  get track(): ActivityTrack | undefined { return this.lastTrack; }

  load(track: ActivityTrack): Course | undefined {
    this.lastTrack = track;
    this.value = track.points.length >= 2 ? new Course(track) : undefined;
    this.emit('course', this.value);
    return this.value;
  }

  unload(): void {
    this.value = undefined;
    this.lastTrack = undefined;
    this.emit('course', undefined);
  }
}

export const courseStore = new CourseStore();
