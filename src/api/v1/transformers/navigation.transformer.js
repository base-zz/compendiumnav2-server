export const transformPosition = (position) => ({
  latitude: position.latitude,
  longitude: position.longitude,
  timestamp: position.timestamp,
  status: position.latitude && position.longitude ? 'valid' : 'invalid'
});

export const transformHeading = (heading) => ({
  magnetic: heading.magnetic,
  true: heading.true,
  deviation: heading.true !== null && heading.magnetic !== null 
    ? heading.true - heading.magnetic 
    : null
});

export const transformSpeed = (speed) => ({
  overGround: speed.overGround,
  throughWater: speed.throughWater,
  units: 'knots'
});

export const transformBatteries = (batteries) => ({
  house: {
    charge: batteries.house.charge,
    voltage: batteries.house.voltage,
    amperage: batteries.house.amperage,
    status: getBatteryStatus(batteries.house)
  },
  start: {
    charge: batteries.start.charge,
    voltage: batteries.start.voltage,
    amperage: batteries.start.amperage,
    status: getBatteryStatus(batteries.start)
  }
});

export const transformTanks = (tanks) => ({
  fuel: {
    level: tanks.fuel.level,
    capacity: tanks.fuel.capacity,
    remaining: tanks.fuel.capacity ? (tanks.fuel.level/100) * tanks.fuel.capacity : null
  },
  water: {
    level: tanks.water.level,
    capacity: tanks.water.capacity
  },
  waste: {
    level: tanks.waste.level,
    capacity: tanks.waste.capacity
  }
});

// Helper function
function getBatteryStatus(battery) {
  if (!battery.voltage) return 'unknown';
  if (battery.voltage > 13.8) return 'charging';
  if (battery.voltage > 12.6) return 'full';
  if (battery.voltage > 12.0) return 'discharging';
  return 'critical';
}