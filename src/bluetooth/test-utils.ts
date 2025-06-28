import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

export function createTempConfigFile(content: string): string {
  const tempDir = path.join(tmpdir(), 'bt-config-test');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const filePath = path.join(tempDir, `test-config-${uuidv4()}.yml`);
  fs.writeFileSync(filePath, content, 'utf8');
  
  return filePath;
}

export function cleanupTempFiles(): void {
  const tempDir = path.join(tmpdir(), 'bt-config-test');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      fs.unlinkSync(path.join(tempDir, file));
    }
    fs.rmdirSync(tempDir);
  }
}

export const sampleConfig = `
company_identifiers:
  - value: 0x1234
    name: 'Test Company 1'
    country: 'US'
  - value: 0x5678
    name: 'Test Company 2'
    country: 'FI'
  - value: '0x9ABC'
    name: 'Test Company 3'
    country: 'JP'
  - value: 12345
    name: 'Test Company 4'
    country: 'UK'
`;
