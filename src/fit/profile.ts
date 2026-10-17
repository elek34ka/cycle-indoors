/** Hand-picked slice of the FIT Profile: just the messages this app reads or writes.
 *  value = raw / scale - offset. Unlisted fields decode as `field_<n>`. */
export interface FieldDef { name: string; scale?: number; offset?: number; semicircles?: boolean; }
export type MessageDef = { name: string; fields: Record<number, FieldDef> };

export const MESSAGES: Record<number, MessageDef> = {
  0: { name: 'file_id', fields: {
    0: { name: 'type' }, 1: { name: 'manufacturer' }, 2: { name: 'product' },
    3: { name: 'serial_number' }, 4: { name: 'time_created' }, 5: { name: 'number' },
    8: { name: 'product_name' },
  } },
  12: { name: 'sport', fields: { 0: { name: 'sport' }, 1: { name: 'sub_sport' }, 3: { name: 'name' } } },
  18: { name: 'session', fields: {
    254: { name: 'message_index' }, 253: { name: 'timestamp' },
    0: { name: 'event' }, 1: { name: 'event_type' }, 2: { name: 'start_time' },
    3: { name: 'start_position_lat', semicircles: true }, 4: { name: 'start_position_long', semicircles: true },
    5: { name: 'sport' }, 6: { name: 'sub_sport' },
    7: { name: 'total_elapsed_time', scale: 1000 }, 8: { name: 'total_timer_time', scale: 1000 },
    9: { name: 'total_distance', scale: 100 }, 11: { name: 'total_calories' },
    14: { name: 'avg_speed', scale: 1000 }, 15: { name: 'max_speed', scale: 1000 },
    16: { name: 'avg_heart_rate' }, 17: { name: 'max_heart_rate' },
    18: { name: 'avg_cadence' }, 19: { name: 'max_cadence' },
    20: { name: 'avg_power' }, 21: { name: 'max_power' },
    22: { name: 'total_ascent' }, 23: { name: 'total_descent' },
    25: { name: 'first_lap_index' }, 26: { name: 'num_laps' },
    34: { name: 'normalized_power' }, 35: { name: 'training_stress_score', scale: 10 },
    36: { name: 'intensity_factor', scale: 1000 },
  } },
  19: { name: 'lap', fields: {
    254: { name: 'message_index' }, 253: { name: 'timestamp' },
    0: { name: 'event' }, 1: { name: 'event_type' }, 2: { name: 'start_time' },
    7: { name: 'total_elapsed_time', scale: 1000 }, 8: { name: 'total_timer_time', scale: 1000 },
    9: { name: 'total_distance', scale: 100 }, 11: { name: 'total_calories' },
    13: { name: 'avg_speed', scale: 1000 }, 14: { name: 'max_speed', scale: 1000 },
    15: { name: 'avg_heart_rate' }, 16: { name: 'max_heart_rate' },
    17: { name: 'avg_cadence' }, 18: { name: 'max_cadence' },
    19: { name: 'avg_power' }, 20: { name: 'max_power' },
    21: { name: 'total_ascent' }, 22: { name: 'total_descent' }, 25: { name: 'sport' },
  } },
  20: { name: 'record', fields: {
    253: { name: 'timestamp' },
    0: { name: 'position_lat', semicircles: true }, 1: { name: 'position_long', semicircles: true },
    2: { name: 'altitude', scale: 5, offset: 500 },
    3: { name: 'heart_rate' }, 4: { name: 'cadence' },
    5: { name: 'distance', scale: 100 }, 6: { name: 'speed', scale: 1000 },
    7: { name: 'power' }, 13: { name: 'temperature' },
    73: { name: 'enhanced_speed', scale: 1000 }, 78: { name: 'enhanced_altitude', scale: 5, offset: 500 },
  } },
  21: { name: 'event', fields: {
    253: { name: 'timestamp' }, 0: { name: 'event' }, 1: { name: 'event_type' }, 3: { name: 'data' },
  } },
  23: { name: 'device_info', fields: {
    253: { name: 'timestamp' }, 0: { name: 'device_index' }, 1: { name: 'device_type' },
    2: { name: 'manufacturer' }, 3: { name: 'serial_number' }, 4: { name: 'product' },
    5: { name: 'software_version', scale: 100 }, 27: { name: 'product_name' },
  } },
  26: { name: 'workout', fields: {
    4: { name: 'sport' }, 5: { name: 'capabilities' }, 6: { name: 'num_valid_steps' }, 8: { name: 'wkt_name' },
  } },
  27: { name: 'workout_step', fields: {
    254: { name: 'message_index' }, 0: { name: 'wkt_step_name' },
    1: { name: 'duration_type' }, 2: { name: 'duration_value' },
    3: { name: 'target_type' }, 4: { name: 'target_value' },
    5: { name: 'custom_target_value_low' }, 6: { name: 'custom_target_value_high' },
    7: { name: 'intensity' }, 8: { name: 'notes' },
  } },
  34: { name: 'activity', fields: {
    253: { name: 'timestamp' }, 0: { name: 'total_timer_time', scale: 1000 },
    1: { name: 'num_sessions' }, 2: { name: 'type' }, 3: { name: 'event' },
    4: { name: 'event_type' }, 5: { name: 'local_timestamp' },
  } },
  49: { name: 'file_creator', fields: { 0: { name: 'software_version' }, 1: { name: 'hardware_version' } } },
};

export const BASE_TYPES: Record<number, { size: number; invalid: number | null; signed: boolean; float: boolean; typeByte: number }> = {
  0:  { size: 1, invalid: 0xff, signed: false, float: false, typeByte: 0x00 }, // enum
  1:  { size: 1, invalid: 0x7f, signed: true,  float: false, typeByte: 0x01 }, // sint8
  2:  { size: 1, invalid: 0xff, signed: false, float: false, typeByte: 0x02 }, // uint8
  3:  { size: 2, invalid: 0x7fff, signed: true,  float: false, typeByte: 0x83 },
  4:  { size: 2, invalid: 0xffff, signed: false, float: false, typeByte: 0x84 },
  5:  { size: 4, invalid: 0x7fffffff, signed: true,  float: false, typeByte: 0x85 },
  6:  { size: 4, invalid: 0xffffffff, signed: false, float: false, typeByte: 0x86 },
  7:  { size: 1, invalid: null, signed: false, float: false, typeByte: 0x07 }, // string
  8:  { size: 4, invalid: null, signed: true,  float: true,  typeByte: 0x88 },
  9:  { size: 8, invalid: null, signed: true,  float: true,  typeByte: 0x89 },
  10: { size: 1, invalid: 0, signed: false, float: false, typeByte: 0x0a },
  11: { size: 2, invalid: 0, signed: false, float: false, typeByte: 0x8b },
  12: { size: 4, invalid: 0, signed: false, float: false, typeByte: 0x8c },
  13: { size: 1, invalid: 0xff, signed: false, float: false, typeByte: 0x0d }, // byte
  14: { size: 8, invalid: 0, signed: true,  float: false, typeByte: 0x8e },
  15: { size: 8, invalid: 0, signed: false, float: false, typeByte: 0x8f },
  16: { size: 8, invalid: 0, signed: false, float: false, typeByte: 0x90 },
};

export const BASE_TYPE = {
  enum: 0x00, sint8: 0x01, uint8: 0x02, sint16: 0x83, uint16: 0x84,
  sint32: 0x85, uint32: 0x86, string: 0x07, float32: 0x88,
  uint8z: 0x0a, uint16z: 0x8b, uint32z: 0x8c, byte: 0x0d,
} as const;
