#!/usr/bin/env node

import process from 'process';
import { ParserRegistry } from '../src/bluetooth/parsers/ParserRegistry.js';
import ParserFactory from '../src/bluetooth/parsers/ParserFactory.js';

function printUsage() {
  console.error('Usage: node scripts/parse-ble.js <hexPayload>');
  console.error('Example: node scripts/parse-ble.js 4703...');
}

async function main() {
  const [, , rawInput] = process.argv;

  if (!rawInput) {
    printUsage();
    process.exit(1);
  }

  const hex = rawInput.trim().replace(/^0x/i, '');

  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    console.error('Invalid hex payload. Provide an even-length hex string.');
    process.exit(1);
  }

  const buffer = Buffer.from(hex, 'hex');

  const factory = new ParserFactory();
  await factory.loadAllParsers();

  const registry = new ParserRegistry();
  for (const [manufacturerId, parser] of factory.getAllParsers()) {
    registry.registerParser({ manufacturerId }, parser);
  }

  const parser = registry.findParserFor(buffer);
  if (!parser) {
    const mid = buffer.readUInt16LE(0);
    console.log(`No parser found for manufacturer 0x${mid.toString(16).toUpperCase()}`);
    process.exit(0);
  }

  try {
    const result = parser.parse(buffer);
    if (!result) {
      console.log('Parser returned no data (null/undefined).');
      process.exit(0);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Failed to parse payload:', error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error.message);
  process.exit(1);
});
