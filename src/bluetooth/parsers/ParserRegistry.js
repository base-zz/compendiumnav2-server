/**
 * Registry for Bluetooth data parsers with support for multiple categories
 * to manage different manufacturers, devices, and parser versions.
 */
export class ParserRegistry {
  constructor() {
    console.log(`[ParserRegistry] Creating new ParserRegistry instance`);
    
    // Primary registry by manufacturer ID
    this.manufacturerParsers = new Map(); // manufacturerId -> Array of parsers
    console.log(`[ParserRegistry] Created manufacturerParsers Map`);
    
    // Secondary indices for faster lookups
    this.deviceParsers = new Map(); // deviceType -> Array of parsers
    console.log(`[ParserRegistry] Created deviceParsers Map`);
    
    this.parserVersions = new Map(); // version -> Array of parsers
    console.log(`[ParserRegistry] Created parserVersions Map`);
    
    this.allParsers = new Set(); // All registered parsers
    console.log(`[ParserRegistry] Created allParsers Set`);
    
    console.log(`[ParserRegistry] ParserRegistry instance created with empty collections`);
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
    console.log(`[ParserRegistry] registerParser called with options:`, options);
    console.log(`[ParserRegistry] Parser type:`, typeof Parser);
    console.log(`[ParserRegistry] Parser has parse method:`, typeof Parser.parse === 'function');
    console.log(`[ParserRegistry] Parser has matches method:`, typeof Parser.matches === 'function');
    
    if (typeof Parser.parse !== 'function') {
      console.log(`[ParserRegistry] ERROR: Parser missing parse method`);
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
    
    console.log(`[ParserRegistry] Extracted manufacturerId:`, manufacturerId);
    
    if (manufacturerId === undefined) {
      console.log(`[ParserRegistry] ERROR: Missing manufacturerId`);
      throw new Error('manufacturerId is required');
    }

    // Add to manufacturer index
    console.log(
      `[ParserRegistry] Adding parser for manufacturerId: 0x${manufacturerId
        .toString(16)
        .toUpperCase()}`
    );
    if (!this.manufacturerParsers.has(manufacturerId)) {
      console.log(
        `[ParserRegistry] Creating new Set for manufacturerId: 0x${manufacturerId
          .toString(16)
          .toUpperCase()}`
      );
      this.manufacturerParsers.set(manufacturerId, new Set());
    }
    this.manufacturerParsers.get(manufacturerId).add(Parser);
    console.log(
      `[ParserRegistry] Parser added to manufacturer index. Count:`,
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
      console.log(
        `[ParserRegistry] Parser added to device index for ${deviceKey}`
      );
    }

    // Add to version index if provided
    if (parserVersion) {
      if (!this.parserVersions.has(parserVersion)) {
        this.parserVersions.set(parserVersion, new Set());
      }
      this.parserVersions.get(parserVersion).add(Parser);
      console.log(
        `[ParserRegistry] Parser added to version index for ${parserVersion}`
      );
    }

    // Add to master set
    console.log(`[ParserRegistry] Adding parser to allParsers set`);
    this.allParsers.add(Parser);
    console.log(`[ParserRegistry] allParsers set size after add:`, this.allParsers.size);
    
    // Log all registered parsers for debugging
    console.log(`[ParserRegistry] Current registered parsers:`);
    for (const parser of this.allParsers) {
      console.log(`[ParserRegistry] - Parser:`, {
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
      console.log(`[ParserRegistry] Invalid data provided to findParserFor:`, data);
      return null;
    }
    
    // Extract manufacturer ID from the first 2 bytes (little endian)
    const manufacturerId = data.readUInt16LE(0);
    console.log(`[ParserRegistry] Looking for parser for manufacturer ID: 0x${manufacturerId.toString(16).toUpperCase()}`);
    
    // Debug the state of the registry
    console.log(`[ParserRegistry] Current registry state:`);
    console.log(`[ParserRegistry] - Total parsers: ${this.allParsers.size}`);
    console.log(`[ParserRegistry] - Manufacturer map size: ${this.manufacturerParsers.size}`);
    console.log(`[ParserRegistry] - Manufacturer map keys:`, [...this.manufacturerParsers.keys()].map(id => `0x${id.toString(16).toUpperCase()}`));
    
    // First try to find a parser by manufacturer ID
    const parsers = this.manufacturerParsers.get(manufacturerId);
    console.log(`[ParserRegistry] Found ${parsers ? parsers.size : 0} registered parsers for this manufacturer ID`);
    
    if (!parsers || parsers.size === 0) {
      console.log(`[ParserRegistry] No parsers registered for manufacturer ID: 0x${manufacturerId.toString(16).toUpperCase()}`);
      return null;
    }

    // If only one parser, use it
    if (parsers.size === 1) {
      const parser = parsers.values().next().value;
      console.log(`[ParserRegistry] Using single registered parser: ${parser.name || parser.constructor.name}`);
      console.log(
        `[ParserRegistry] Using single registered parser: ${
          parser.name || parser.constructor.name
        }`
      );
      return parser;
    }

    // If multiple parsers, try to find the best match using the matches() method if available
    console.log(
      `[ParserRegistry] Multiple parsers found, looking for best match...`
    );
    for (const parser of parsers) {
      if (typeof parser.matches === "function") {
        console.log(
          `[ParserRegistry] Testing parser ${
            parser.name || parser.constructor.name
          } with matches() method`
        );
        if (parser.matches(data)) {
          console.log(
            `[ParserRegistry] Found matching parser: ${
              parser.name || parser.constructor.name
            }`
          );
          return parser;
        }
      }
    }

    // If no specific matcher, return the first parser for this manufacturer
    const defaultParser = parsers.values().next().value;
    console.log(
      `[ParserRegistry] No specific match found, using default parser: ${
        defaultParser.name || defaultParser.constructor.name
      }`
    );
    return defaultParser;
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
    console.log(`[ParserRegistry] getAllParsers called, returning ${this.allParsers.size} parsers`);
    // Log each parser for debugging
    for (const parser of this.allParsers) {
      console.log(`[ParserRegistry] - Parser in getAllParsers:`, {
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

export default ParserRegistry;
