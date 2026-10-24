/** Sample workouts shipped with the app, written as .zwo so they exercise the
 *  same parser as a file the user drops in. */
export interface LibraryEntry { id: string; title: string; summary: string; zwo: string; }

const wrap = (name: string, body: string, description: string) => `<workout_file>
  <author>Cycle Indoors</author>
  <name>${name}</name>
  <description>${description}</description>
  <sportType>bike</sportType>
  <workout>${body}</workout>
</workout_file>`;


/** A long free ride: no targets at all, split into hour blocks so the ride
 *  auto-laps every hour and the block list stays readable. Free-ride blocks
 *  override ERG mode, so the trainer follows the gradient (or the loaded
 *  route) rather than a power target. */
const freeRide = (hours: number) => {
  const blocks: string[] = [];
  for (let hour = 0; hour < hours; hour++) {
    const message = hour === 0
      ? 'Free ride — no targets. Ride however you feel.'
      : `${hour} hour${hour === 1 ? '' : 's'} done`;
    blocks.push(`
    <FreeRide Duration="3600">
      <textevent timeoffset="${hour === 0 ? 15 : 5}" message="${message}" duration="12"/>
    </FreeRide>`);
  }
  return blocks.join('');
};

export const LIBRARY: LibraryEntry[] = [
  {
    id: 'quick-test',
    title: 'Quick test (5 min)',
    summary: '5 min · everything in miniature, for checking the app end to end',
    zwo: wrap('Quick test', `
    <Warmup Duration="60" PowerLow="0.40" PowerHigh="0.70"/>
    <SteadyState Duration="45" Power="0.85" Cadence="90">
      <textevent timeoffset="2" message="Steady block — hold 85%" duration="8"/>
    </SteadyState>
    <IntervalsT Repeat="3" OnDuration="20" OffDuration="25" OnPower="1.15" OffPower="0.45" Cadence="100" CadenceResting="85"/>
    <FreeRide Duration="45"/>
    <Ramp Duration="45" PowerLow="0.60" PowerHigh="1.10"/>
    <Cooldown Duration="60" PowerLow="0.60" PowerHigh="0.40"/>`, 'A tiny workout that touches every block type.'),
  },
  {
    id: 'sweet-spot',
    title: 'Sweet spot 3 x 12',
    summary: '62 min · 3 x 12 min at 90% FTP',
    zwo: wrap('Sweet spot 3 x 12', `
    <Warmup Duration="600" PowerLow="0.45" PowerHigh="0.75"/>
    <SteadyState Duration="60" Power="0.95" Cadence="95"/>
    <SteadyState Duration="60" Power="0.50"/>
    <IntervalsT Repeat="3" OnDuration="720" OffDuration="300" OnPower="0.90" OffPower="0.50" Cadence="90" CadenceResting="85"/>
    <Cooldown Duration="480" PowerLow="0.65" PowerHigh="0.40"/>`, 'Sustainable aerobic load just under threshold.'),
  },
  {
    id: 'vo2-5x3',
    title: 'VO2 max 5 x 3',
    summary: '58 min · 5 x 3 min at 115% FTP',
    zwo: wrap('VO2 max 5 x 3', `
    <Warmup Duration="600" PowerLow="0.45" PowerHigh="0.80"/>
    <IntervalsT Repeat="3" OnDuration="30" OffDuration="30" OnPower="1.10" OffPower="0.45" Cadence="105"/>
    <SteadyState Duration="180" Power="0.50"/>
    <IntervalsT Repeat="5" OnDuration="180" OffDuration="180" OnPower="1.15" OffPower="0.45" Cadence="95" CadenceResting="85"/>
    <Cooldown Duration="420" PowerLow="0.60" PowerHigh="0.40"/>`, 'Hard aerobic intervals with equal recovery.'),
  },
  {
    id: 'endurance-75',
    title: 'Endurance 75',
    summary: '75 min · steady zone 2 with tempo surges',
    zwo: wrap('Endurance 75', `
    <Warmup Duration="600" PowerLow="0.40" PowerHigh="0.65"/>
    <SteadyState Duration="1200" Power="0.68" Cadence="88"/>
    <IntervalsT Repeat="4" OnDuration="120" OffDuration="300" OnPower="0.85" OffPower="0.65" Cadence="95" CadenceResting="88"/>
    <SteadyState Duration="600" Power="0.66"/>
    <Cooldown Duration="300" PowerLow="0.60" PowerHigh="0.40"/>`, 'Long aerobic ride with short tempo lifts.'),
  },
  {
    id: 'free-ride-1h',
    title: 'Free ride 1 h',
    summary: '1:00 · no targets',
    zwo: wrap('Free ride 1 h', freeRide(1),
      'An hour of free riding with no power targets. Use free mode with a '
      + 'gradient, or load a route and let its gradient drive the trainer.'),
  },
  {
    id: 'ramp-test',
    title: 'Ramp test',
    summary: '~25 min · ride to failure, 20 W per minute',
    zwo: wrap('Ramp test', `
    <Warmup Duration="300" PowerLow="0.35" PowerHigh="0.50"/>
    <Ramp Duration="1500" PowerLow="0.50" PowerHigh="1.80">
      <textevent timeoffset="0" message="Hold on as long as you can" duration="10"/>
    </Ramp>
    <Cooldown Duration="300" PowerLow="0.45" PowerHigh="0.35"/>`, 'A continuous ramp for estimating FTP.'),
  },
];
