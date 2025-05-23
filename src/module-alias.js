import { addAlias } from 'module-alias';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Add aliases for module resolution
addAlias('@capacitor/preferences', join(__dirname, 'mocks/capacitor-preferences.js'));
addAlias('@compendiumnav2/shared', join(__dirname, 'shared'));
