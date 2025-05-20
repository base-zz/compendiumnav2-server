import { addAlias } from 'module-alias';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Add alias for @capacitor/preferences to use our mock implementation
addAlias('@capacitor/preferences', join(__dirname, 'mocks/capacitor-preferences.js'));
