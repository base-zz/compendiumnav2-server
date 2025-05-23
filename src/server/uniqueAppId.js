import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { v4: uuidv4 } = require('uuid');
import fs from 'fs';
import path from 'path';

const UUID_FILE = path.resolve(process.cwd(), '.app-uuid');

export function getOrCreateAppUuid() {
  if (fs.existsSync(UUID_FILE)) {
    // Read and return existing UUID
    // console.log('Using existing app UUID:', fs.readFileSync(UUID_FILE, 'utf8').trim());
    return fs.readFileSync(UUID_FILE, 'utf8').trim();
  }
  // Generate, persist, and return new UUID
  const newUuid = uuidv4();
  fs.writeFileSync(UUID_FILE, newUuid, 'utf8');
  return newUuid;
}