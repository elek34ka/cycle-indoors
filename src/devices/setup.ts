import { createMockRig } from './mock';
import { hub } from './hub';

/** The simulated rider used in phase 1 (and handy later for testing the UI
 *  without climbing on the bike). */
export const mock = createMockRig();

export function registerMockDevices(): void {
  hub.register(mock.trainer);
  hub.register(mock.hrm);
}
