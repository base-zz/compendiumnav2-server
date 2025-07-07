import debug from 'debug';

const log = debug('cn2:parser-registry');
const logError = debug('cn2:parser-registry:error');

/**
 * Registry for Bluetooth data parsers with support for multiple categories
 * to manage different manufacturers, devices, and parser versions.
 */
export class ParserRegistry {
  constructor() {
    log(`Creating new ParserRegistry instance`);
    
    // Primary registry by manufacturer ID
    this.manufacturerParsers = new Map(); // manufacturerId -> Array of parsers
    log(`Created manufacturerParsers Map`);
    
    // Secondary indices for faster lookups
    this.deviceParsers = new Map(); // deviceType -> Array of parsers
    log(`Created deviceParsers Map`);
    
    this.parserVersions = new Map(); // version -> Array of parsers
    log(`Created parserVersions Map`);
    
    this.allParsers = new Set(); // All registered parsers
    log(`Created allParsers Set`);
    
    log(`ParserRegistry instance created with empty collections`);
  }

  /**
   * Register a parser with metadata
   * @param {Object} options - Parser registration options
   * @param {number} options.manufacturerId - Manufacturer ID (e.g., 0x0499 for Ruuvi)
   * @param {string} [options.deviceType] - Device type/name (e.g., 'RuuviTag', 'BilgePump')
   * @param {string} [options.deviceVersion] - Device version (e.g., '1.0', '2.0')
   * @param {string} [options.parserVersion] - Parser version (e.g., '1.0.0')
   * @param {Object} Parser - The parser class/object (must implement static parse() method)
   * @param {function} Parser.parse - Static parse method
   * @param {function} [Parser.matches] - Optional static method to check if parser matches data
   */
  registerParser(options, Parser) {
    log(`registerParser called with options:`, options);
    log(`Parser type:`, typeof Parser);
    log(`Parser has parse method:`, typeof Parser.parse === 'function');
    log(`Parser has matches method:`, typeof Parser.matches === 'function');
    
    if (typeof Parser.parse !== 'function') {
      logError(`Parser missing parse method`);
      throw new Error('Parser must implement parse() method');
    }
    
    // Handle both formats: (options, parser) and (manufacturerId, parser)
    let manufacturerId, deviceType, deviceVersion, parserVersion;
    
    if (typeof options === 'object' && options !== null) {
      // Format: (options, parser)
      manufacturerId = options.manufacturerId;
      deviceType = options.deviceType;
      deviceVersion = options.deviceVersion;
      parserVersion = options.parserVersion;
    } else if (typeof options === 'number') {
      // Format: (manufacturerId, parser)
      manufacturerId = options;
    }
    
    log(`Extracted manufacturerId:`, manufacturerId);
    
    if (manufacturerId === undefined) {
      logError(`Missing manufacturerId`);
      throw new Error('manufacturerId is required');
    }

    // Add to manufacturer index
    log(
      `Adding parser for manufacturerId: 0x${manufacturerId
        .toString(16)
        .toUpperCase()}`
    );
    if (!this.manufacturerParsers.has(manufacturerId)) {
      log(
        `Creating new Set for manufacturerId: 0x${manufacturerId
          .toString(16)
          .toUpperCase()}`
      );
      this.manufacturerParsers.set(manufacturerId, new Set());
    }
    this.manufacturerParsers.get(manufacturerId).add(Parser);
    log(
      `Parser added to manufacturer index. Count:`,
      this.manufacturerParsers.get(manufacturerId).size
    );

    // Add to device type index if provided
    if (deviceType) {
      const deviceKey = deviceVersion
        ? `${deviceType}:${deviceVersion}`
        : deviceType;
      if (!this.deviceParsers.has(deviceKey)) {
        this.deviceParsers.set(deviceKey, new Set());
      }
      this.deviceParsers.get(deviceKey).add(Parser);
      log(
        `Parser added to device index for ${deviceKey}`
      );
    }

    // Add to version index if provided
    if (parserVersion) {
      if (!this.parserVersions.has(parserVersion)) {
        this.parserVersions.set(parserVersion, new Set());
      }
      this.parserVersions.get(parserVersion).add(Parser);
      log(
        `Parser added to version index for ${parserVersion}`
      );
    }

    // Add to master set
    log(`Adding parser to allParsers set`);
    this.allParsers.add(Parser);
    log(`allParsers set size after add:`, this.allParsers.size);
    
    // Log all registered parsers for debugging
    log(`Current registered parsers:`);
    for (const parser of this.allParsers) {
      log(`- Parser:`, {
        name: parser.name || parser.constructor?.name,
        hasParse: typeof parser.parse === 'function',
        hasMatches: typeof parser.matches === 'function',
        manufacturerId: parser.manufacturerId ? `0x${parser.manufacturerId.toString(16).toUpperCase()}` : 'unknown'
      });
    }

    return this; // Allow chaining
  }

  /**
   * Get parsers by manufacturer ID
   * @param {number} manufacturerId - The manufacturer ID
   * @returns {Set<Object>} - Set of matching parsers
   */
  getByManufacturer(manufacturerId) {
    return this.manufacturerParsers.get(manufacturerId) || new Set();
  }

  /**
   * Get parsers by device type and optional version
   * @param {string} deviceType - Device type/name
   * @param {string} [version] - Optional device version
   * @returns {Set<Object>} - Set of matching parsers
   */
  getByDevice(deviceType, version) {
    const deviceKey = version ? `${deviceType}:${version}` : deviceType;
    return this.deviceParsers.get(deviceKey) || new Set();
  }

  /**
   * Get parsers by version
   * @param {string} version - Parser version
   * @returns {Set<Object>} - Set of matching parsers
   */
  getByVersion(version) {
    return this.parserVersions.get(version) || new Set();
  }

  /**
   * Find the best matching parser for the given manufacturer data
   * @param {Buffer} data - Raw manufacturer data
   * @returns {Object|null} - The most appropriate parser or null if none found
   */
  findParserFor(data) {
    if (!data || data.length < 2) {
      logError(`Invalid data provided to findParserFor:`, data);
      return null;
    }

    // Extract manufacturer ID from the first 2 bytes (little endian)
    const manufacturerId = data.readUInt16LE(0);

    // First, check if we have any parsers for this manufacturer ID.
    const parsers = this.manufacturerParsers.get(manufacturerId);

    // If no parsers are registered for this ID, silently return null.
    // This is the key change to stop logging for unsupported devices.
    if (!parsers || parsers.size === 0) {
      return null;
    }

    // --- From this point on, we know a parser exists, so logging is useful for debugging. ---
    
    log(`Found ${parsers.size} registered parser(s) for manufacturer ID: 0x${manufacturerId.toString(16).toUpperCase()}`);

    // If only one parser, use it.
    if (parsers.size === 1) {
      const parser = parsers.values().next().value;
      log(`Using single registered parser: ${parser.name || parser.constructor.name}`);
      return parser;
    }

    // If multiple parsers, try to find the best match using the matches() method.
    log(`Multiple parsers found, looking for best match...`);
    for (const parser of parsers) {
      if (typeof parser.matches === "function") {
        log(`Testing parser: ${parser.name || parser.constructor.name}`);
        if (parser.matches(data)) {
          log(`Found matching parser: ${parser.name || parser.constructor.name}`);
          return parser;
        }
      }
    }
    
    // Fallback: if no specific match found, return the first registered parser.
    // This case might need refinement depending on desired behavior.
    const fallbackParser = parsers.values().next().value;
    log(`No specific match found, using first registered parser as fallback: ${fallbackParser.name || fallbackParser.constructor.name}`);
    return fallbackParser;
  }

  /**
   * Parse manufacturer data using the best matching parser
   * @param {Buffer} manufacturerData - Raw manufacturer data
   * @returns {Object|null} - Parsed data or null if no parser found
   */
  parse(manufacturerData) {
    const Parser = this.findParserFor(manufacturerData);
    return Parser ? Parser.parse(manufacturerData) : null;
  }

  /**
   * Get all registered parsers
   * @returns {Set<Object>} - Set of all registered parsers
   */
  getAllParsers() {
    log(`getAllParsers called, returning ${this.allParsers.size} parsers`);
    // Log each parser for debugging
    for (const parser of this.allParsers) {
      log(`- Parser in getAllParsers:`, {
        name: parser.name || parser.constructor?.name,
        hasParse: typeof parser.parse === 'function',
        hasMatches: typeof parser.matches === 'function',
        manufacturerId: parser.manufacturerId ? `0x${parser.manufacturerId.toString(16).toUpperCase()}` : 'unknown'
      });
    }
    return this.allParsers;
  }

  /**
   * Clear all registered parsers
   */
  clear() {
    this.manufacturerParsers.clear();
    this.deviceParsers.clear();
    this.parserVersions.clear();
    this.allParsers.clear();
  }
}


