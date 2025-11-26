#!/usr/bin/env node
import ModbusRTU from 'modbus-serial';
import { scanVictronDevices } from './src/services/victron/discoveryHelpers.js';

const EXIT_USAGE = 64; // sysexits.h EX_USAGE

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { positional: [] };

  let index = 0;
  while (index < args.length) {
    const token = args[index];

    if (token === '--help' || token === '-h') {
      options.help = true;
      index += 1;
      continue;
    }

    if (token.startsWith('--')) {
      const [flag, rawValue] = token.split('=');
      const key = flag.slice(2);

      if (!key) {
        throw new Error(`Invalid flag syntax: "${token}"`);
      }

      if (rawValue !== undefined) {
        options[key] = rawValue;
        index += 1;
        continue;
      }

      const next = args[index + 1];
      if (next && !next.startsWith('--')) {
        options[key] = next;
        index += 2;
        continue;
      }

      options[key] = true;
      index += 1;
      continue;
    }

    options.positional.push(token);
    index += 1;
  }

  return options;
}

function showUsage() {
  console.log(`Usage: node test-modbus-discovery.js --host <ip> --port <number> --range <start-end> [options]

Required flags:
  --host <ip or hostname>          Cerbo GX host name or IP address
  --port <number>                  Modbus TCP port (for Victron, typically 502)
  --range <start-end>              Unit ID scan range, e.g. 0-247

Optional flags:
  --timeout <ms>                   Request timeout in milliseconds
  --delay <ms>                     Delay between unit ID scans
  --verbose                        Print per-unit diagnostic output
  --retries <count>                Retry individual register reads up to count times
`);
}

function ensureRequired(option, name) {
  if (option === undefined || option === null || option === '') {
    throw new Error(`Missing required flag --${name}`);
  }
}

function toInteger(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for --${flagName}: "${value}"`);
  }
  return parsed;
}

function parseRange(rangeFlag) {
  if (typeof rangeFlag !== 'string') {
    throw new Error('Scan range must be provided as <start-end>.');
  }
  const parts = rangeFlag.split('-');
  if (parts.length !== 2) {
    throw new Error(`Invalid range format: "${rangeFlag}". Expected <start-end>.`);
  }
  const start = toInteger(parts[0], 'range');
  const end = toInteger(parts[1], 'range');
  if (start < 0 || end < 0 || start > 247 || end > 247) {
    throw new Error('Range boundaries must be between 0 and 247 inclusive.');
  }
  if (start > end) {
    throw new Error('Range start must be less than or equal to range end.');
  }
  return { start, end };
}

async function main() {
  const parsedArgs = parseArgs();

  if (parsedArgs.help) {
    showUsage();
    process.exit(0);
  }

  try {
    ensureRequired(parsedArgs.host, 'host');
    ensureRequired(parsedArgs.port, 'port');
    ensureRequired(parsedArgs.range, 'range');
  } catch (error) {
    console.error(error.message);
    showUsage();
    process.exit(EXIT_USAGE);
  }

  const host = parsedArgs.host;
  const port = toInteger(parsedArgs.port, 'port');
  const range = parseRange(parsedArgs.range);
  const timeout = parsedArgs.timeout !== undefined ? toInteger(parsedArgs.timeout, 'timeout') : undefined;
  const delay = parsedArgs.delay !== undefined ? toInteger(parsedArgs.delay, 'delay') : 0;
  const retries = parsedArgs.retries !== undefined ? toInteger(parsedArgs.retries, 'retries') : 0;
  const verbose = Boolean(parsedArgs.verbose);

  if (timeout !== undefined && timeout <= 0) {
    console.error('Timeout must be greater than zero.');
    process.exit(EXIT_USAGE);
  }
  if (delay < 0) {
    console.error('Delay must be zero or a positive integer.');
    process.exit(EXIT_USAGE);
  }
  if (retries < 0) {
    console.error('Retries must be zero or a positive integer.');
    process.exit(EXIT_USAGE);
  }

  const client = new ModbusRTU();

  console.log(`Connecting to ${host}:${port} ...`);
  try {
    await client.connectTCP(host, { port });
    if (timeout !== undefined) {
      client.setTimeout(timeout);
    }
    console.log('Connection established. Starting discovery...');
  } catch (error) {
    console.error(`Failed to connect: ${error.message}`);
    process.exit(1);
  }

  let discoveryResults;

  try {
    discoveryResults = await scanVictronDevices({
      client,
      range,
      retries,
      delay,
      verbose,
      defaultUnitId: 100,
      onUnitResult: result => {
        if (result.devices.length > 0) {
          console.log(`\nUnit ID ${result.unitId} responded:`);
          result.devices.forEach(device => {
            console.log(`  • ${device.label} [${device.type}]`);
            console.log(`    Details: ${JSON.stringify(device.details, null, 2).replace(/\n/g, '\n    ')}`);
          });
        } else if (verbose) {
          console.log(`Unit ID ${result.unitId} returned no recognizable responses.`);
        }
      }
    });
  } catch (error) {
    console.error(`Discovery failed: ${error.message}`);
    discoveryResults = null;
  } finally {
    if (client.isOpen) {
      client.close();
    }
  }

  if (!discoveryResults || discoveryResults.devices.length === 0) {
    console.log('No recognizable devices were found in the specified range.');
    process.exit(discoveryResults ? 0 : 1);
  }

  console.log(`\nDiscovery finished in ${discoveryResults.durationMs} ms.`);

  console.log('\nSummary (JSON):');
  console.log(JSON.stringify({
    host,
    port,
    range,
    discoveredAt: new Date().toISOString(),
    units: discoveryResults.units.map(result => ({
      unitId: result.unitId,
      devices: result.devices.map(device => ({
        type: device.type,
        label: device.label,
        details: device.details
      }))
    })),
    devices: discoveryResults.devices
  }, null, 2));
}

main().catch(error => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
