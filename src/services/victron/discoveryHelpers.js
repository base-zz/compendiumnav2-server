const DEFAULT_RANGE = { start: 0, end: 247 };

function createLogger(options = {}) {
  const { verbose = false, logger } = options;
  if (!verbose) {
    return {
      info: () => {},
      warn: () => {}
    };
  }
  const fallback = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args)
  };
  return {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : fallback.info,
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : fallback.warn
  };
}

function toSignedInt16(value) {
  if (value > 0x7fff) {
    return value - 0x10000;
  }
  return value;
}

function hasRegisterData(response) {
  return Boolean(response && Array.isArray(response.data) && response.data.length > 0 && response.data[0] !== undefined);
}

function countDefinedFields(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countDefinedFields(item), 0);
  }
  if (typeof value === 'object') {
    return Object.values(value).reduce((count, item) => count + countDefinedFields(item), 0);
  }
  return 0;
}

function chooseRepresentative(current, candidate) {
  if (!current) {
    return candidate;
  }
  const currentScore = countDefinedFields(current);
  const candidateScore = countDefinedFields(candidate);
  if (candidateScore > currentScore) {
    return candidate;
  }
  return current;
}

async function readInputRegister(client, unitId, register, length, { retries, delay, logger }) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      client.setID(unitId);
      return await client.readInputRegisters(register, length);
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      attempt += 1;
      logger.warn(`[unit ${unitId}] readInputRegisters(${register}, ${length}) retry ${attempt}/${retries}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return null;
}

async function readHoldingRegister(client, unitId, register, length, { retries, delay, logger }) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      client.setID(unitId);
      return await client.readHoldingRegisters(register, length);
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      attempt += 1;
      logger.warn(`[unit ${unitId}] readHoldingRegisters(${register}, ${length}) retry ${attempt}/${retries}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return null;
}

const detectors = [
  {
    type: 'battery_monitor',
    label: 'Battery Monitor (BMV)',
    async detect(client, unitId, options) {
      const voltageResponse = await readInputRegister(client, unitId, 259, 1, options);
      if (!hasRegisterData(voltageResponse)) {
        return null;
      }
      const rawVoltage = voltageResponse.data[0];
      const voltage = rawVoltage / 100;
      if (!Number.isFinite(voltage) || voltage <= 5 || voltage >= 100) {
        return null;
      }

      const currentResponse = await readInputRegister(client, unitId, 261, 1, options);
      const powerResponse = await readInputRegister(client, unitId, 258, 1, options);
      const socResponse = await readInputRegister(client, unitId, 266, 1, options);

      if (!hasRegisterData(currentResponse) || !hasRegisterData(powerResponse) || !hasRegisterData(socResponse)) {
        return null;
      }

      const current = toSignedInt16(currentResponse.data[0]) / 10;
      const power = toSignedInt16(powerResponse.data[0]);
      const rawSoc = socResponse.data[0];
      const soc = rawSoc / 10;

      if (!Number.isFinite(soc) || rawSoc === 0xffff || soc < 0 || soc > 100) {
        return null;
      }

      return {
        voltage,
        current,
        power,
        soc,
        raw: {
          voltage: rawVoltage,
          current: currentResponse.data[0],
          power: powerResponse.data[0],
          soc: rawSoc
        }
      };
    }
  },
  {
    type: 'solar_charger',
    label: 'Solar Charger (MPPT)',
    async detect(client, unitId, options) {
      const voltageResponse = await readHoldingRegister(client, unitId, 771, 1, options);
      if (!hasRegisterData(voltageResponse)) {
        return null;
      }
      const rawVoltage = voltageResponse.data[0];
      const voltage = rawVoltage / 100;
      if (!Number.isFinite(voltage) || voltage < 0 || voltage > 200) {
        return null;
      }

      const currentResponse = await readHoldingRegister(client, unitId, 772, 1, options);
      const powerResponse = await readHoldingRegister(client, unitId, 789, 1, options);
      const stateResponse = await readHoldingRegister(client, unitId, 775, 1, options);
      const yieldTodayResponse = await readHoldingRegister(client, unitId, 784, 1, options);

      if (!hasRegisterData(currentResponse) || !hasRegisterData(powerResponse) || !hasRegisterData(stateResponse)) {
        return null;
      }

      const current = currentResponse.data[0] / 10;
      const power = powerResponse.data[0] / 10;
      const state = stateResponse.data[0];
      const yieldToday = hasRegisterData(yieldTodayResponse) ? yieldTodayResponse.data[0] / 100 : null;

      return {
        voltage,
        current,
        power,
        state,
        yieldToday,
        raw: {
          voltage: rawVoltage,
          current: currentResponse.data[0],
          power: powerResponse.data[0],
          state,
          yieldToday: hasRegisterData(yieldTodayResponse) ? yieldTodayResponse.data[0] : null
        }
      };
    }
  },
  {
    type: 'multiplus',
    label: 'MultiPlus / VE.Bus Device',
    async detect(client, unitId, options) {
      const stateResponse = await readHoldingRegister(client, unitId, 31, 1, options);
      if (!hasRegisterData(stateResponse)) {
        return null;
      }
      const state = stateResponse.data[0];
      if (!Number.isInteger(state) || state < 0 || state > 100) {
        return null;
      }

      const acInputVoltage = await readHoldingRegister(client, unitId, 3, 1, options);
      const acInputCurrent = await readHoldingRegister(client, unitId, 6, 1, options);
      const acInputPower = await readHoldingRegister(client, unitId, 12, 1, options);
      const acOutputVoltage = await readHoldingRegister(client, unitId, 15, 1, options);
      const acOutputCurrent = await readHoldingRegister(client, unitId, 18, 1, options);
      const acOutputPower = await readHoldingRegister(client, unitId, 23, 1, options);

      if (!hasRegisterData(acInputVoltage) || !hasRegisterData(acInputCurrent) || !hasRegisterData(acOutputPower)) {
        return null;
      }

      return {
        state,
        acInput: {
          voltage: acInputVoltage.data[0] / 10,
          current: toSignedInt16(acInputCurrent.data[0]) / 10,
          power: toSignedInt16(acInputPower.data[0]) * 10,
          raw: {
            voltage: acInputVoltage.data[0],
            current: acInputCurrent.data[0],
            power: acInputPower.data[0]
          }
        },
        acOutput: {
          voltage: acOutputVoltage.data[0] / 10,
          current: toSignedInt16(acOutputCurrent.data[0]) / 10,
          power: toSignedInt16(acOutputPower.data[0]) * 10,
          raw: {
            voltage: acOutputVoltage.data[0],
            current: acOutputCurrent.data[0],
            power: acOutputPower.data[0]
          }
        }
      };
    }
  },
  {
    type: 'system_dc',
    label: 'System DC Summary',
    async detect(client, unitId, options) {
      const voltageResponse = await readHoldingRegister(client, unitId, 840, 1, options);
      if (!hasRegisterData(voltageResponse)) {
        return null;
      }

      const currentResponse = await readHoldingRegister(client, unitId, 842, 1, options);
      const powerResponse = await readHoldingRegister(client, unitId, 841, 1, options);

      if (!hasRegisterData(currentResponse) || !hasRegisterData(powerResponse)) {
        return null;
      }

      const rawVoltage = voltageResponse.data[0];
      const rawCurrent = currentResponse.data[0];
      const rawPower = powerResponse.data[0];

      return {
        voltage: rawVoltage / 10,
        current: toSignedInt16(rawCurrent) / 10,
        power: toSignedInt16(rawPower),
        raw: {
          voltage: rawVoltage,
          current: rawCurrent,
          power: rawPower
        }
      };
    }
  }
];

async function inspectUnitId(client, unitId, options) {
  const discovered = [];
  const errors = [];

  for (const detector of detectors) {
    try {
      const details = await detector.detect(client, unitId, options);
      if (details) {
        discovered.push({
          type: detector.type,
          label: detector.label,
          details
        });
      }
    } catch (error) {
      errors.push({ type: detector.type, message: error.message });
      options.logger.warn(`[unit ${unitId}] ${detector.type} detection error: ${error.message}`);
    }
  }

  return { unitId, devices: discovered, errors };
}

function deduplicateDevices(unitResults) {
  const dedupeMap = new Map();

  for (const unit of unitResults) {
    for (const device of unit.devices) {
      const key = `${device.type}::${device.label}`;
      if (!dedupeMap.has(key)) {
        dedupeMap.set(key, {
          type: device.type,
          label: device.label,
          representative: device.details,
          sources: [{ unitId: unit.unitId, details: device.details }]
        });
      } else {
        const existing = dedupeMap.get(key);
        existing.sources.push({ unitId: unit.unitId, details: device.details });
        existing.representative = chooseRepresentative(existing.representative, device.details);
      }
    }
  }

  return Array.from(dedupeMap.values()).map(entry => ({
    type: entry.type,
    label: entry.label,
    representative: entry.representative,
    sources: entry.sources
  }));
}

export async function scanVictronDevices(input = {}) {
  const {
    client,
    range = DEFAULT_RANGE,
    retries = 0,
    delay = 0,
    verbose = false,
    defaultUnitId = 100,
    logger,
    onUnitResult
  } = input;

  if (!client) {
    throw new Error('Modbus client is required for Victron discovery');
  }
  const log = createLogger({ verbose, logger });
  const options = {
    retries,
    delay,
    logger: log
  };
  const unitResults = [];
  const startTime = Date.now();
  const effectiveRange = {
    start: typeof range?.start === 'number' ? range.start : DEFAULT_RANGE.start,
    end: typeof range?.end === 'number' ? range.end : DEFAULT_RANGE.end
  };
  if (effectiveRange.start < 0 || effectiveRange.end > 247 || effectiveRange.start > effectiveRange.end) {
    throw new Error('Invalid unit ID range for discovery');
  }
  const onResult = typeof onUnitResult === 'function' ? onUnitResult : () => {};

  try {
    for (let unitId = effectiveRange.start; unitId <= effectiveRange.end; unitId += 1) {
      const inspection = await inspectUnitId(client, unitId, options);
      unitResults.push(inspection);
      onResult(inspection);
      if (delay > 0 && unitId < effectiveRange.end) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  } finally {
    if (typeof defaultUnitId === 'number') {
      try {
        client.setID(defaultUnitId);
      } catch {}
    }
  }

  const devices = deduplicateDevices(unitResults);
  const durationMs = Date.now() - startTime;

  return {
    units: unitResults,
    devices,
    durationMs
  };
}

export {
  toSignedInt16,
  hasRegisterData,
  countDefinedFields,
  chooseRepresentative
};
