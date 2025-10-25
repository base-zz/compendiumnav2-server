import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ConfigurableParser from './ConfigurableParser.js';
import VictronParser from './VictronParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * ParserFactory - Loads and creates parsers from configuration files
 */
class ParserFactory {
  constructor() {
    this.configDir = path.join(__dirname, 'configs');
    this.parsers = new Map();
  }

  /**
   * Load all parser configurations from the configs directory
   * @returns {Promise<Map>} Map of manufacturerId -> parser instance
   */
  async loadAllParsers() {
    try {
      // Check if configs directory exists
      try {
        await fs.access(this.configDir);
      } catch {
        console.warn(`Parser configs directory not found: ${this.configDir}`);
        return this.parsers;
      }

      // Read all JSON files in the configs directory
      const files = await fs.readdir(this.configDir);
      const configFiles = files.filter(f => f.endsWith('.json'));

      console.log(`[ParserFactory] Found ${configFiles.length} parser config files`);

      for (const file of configFiles) {
        try {
          await this.loadParserFromFile(path.join(this.configDir, file));
        } catch (error) {
          console.error(`[ParserFactory] Failed to load parser from ${file}:`, error.message);
        }
      }

      console.log(`[ParserFactory] Loaded ${this.parsers.size} parsers`);
      return this.parsers;
    } catch (error) {
      console.error('[ParserFactory] Failed to load parsers:', error);
      return this.parsers;
    }
  }

  /**
   * Load a parser from a configuration file
   * @param {string} filePath - Path to the configuration file
   * @returns {Promise<ConfigurableParser>} The created parser
   */
  async loadParserFromFile(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    const config = JSON.parse(content);
    
    return this.createParserFromConfig(config);
  }

  /**
   * Create a parser from a configuration object
   * @param {Object} config - Parser configuration
   * @returns {ConfigurableParser|VictronParser} The created parser
   */
  createParserFromConfig(config) {
    // Validate required fields
    if (!config.manufacturerId) {
      throw new Error('Parser config must have a manufacturerId');
    }

    if (!config.formats || config.formats.length === 0) {
      throw new Error('Parser config must have at least one format');
    }

    // Use VictronParser for Victron devices (manufacturer ID 0x2E1 = 737)
    // VictronParser handles bit-packed data correctly
    let parser;
    if (config.manufacturerId === 737) {
      parser = new VictronParser(config);
    } else {
      // Use ConfigurableParser for other devices
      parser = new ConfigurableParser(config);
    }
    
    // Store it in the map
    this.parsers.set(config.manufacturerId, parser);
    
    return parser;
  }

  /**
   * Get a parser by manufacturer ID
   * @param {number} manufacturerId - The manufacturer ID
   * @returns {ConfigurableParser|null} The parser or null if not found
   */
  getParser(manufacturerId) {
    return this.parsers.get(manufacturerId) || null;
  }

  /**
   * Get all loaded parsers
   * @returns {Map} Map of manufacturerId -> parser
   */
  getAllParsers() {
    return this.parsers;
  }

  /**
   * Load a parser from a JSON string
   * @param {string} jsonString - JSON configuration string
   * @returns {ConfigurableParser} The created parser
   */
  loadParserFromJSON(jsonString) {
    const config = JSON.parse(jsonString);
    return this.createParserFromConfig(config);
  }
}

export default ParserFactory;
