/**
 * Base parser class for custom Bluetooth device parsers
 * All custom parsers should extend this class
 */
export class BaseCustomParser {
  static manufacturerId = null;
  
  /**
   * Parse manufacturer data
   * @param {Buffer} data - Raw manufacturer data (including manufacturer ID)
   * @returns {Object|null} Parsed data or null if invalid
   */
  static parse(data) {
    if (!data || data.length < 2) return null;
    
    // Default implementation returns basic info
    return {
      format: 'unknown',
      manufacturerId: this.manufacturerId,
      raw: data.toString('hex')
    };
  }
  
  /**
   * Check if this parser can handle the given manufacturer data
   * @param {Buffer} manufacturerData - Raw manufacturer data
   * @returns {boolean} True if this parser can handle the data
   */
  static matches(manufacturerData) {
    if (!manufacturerData || manufacturerData.length < 2) return false;
    const id = manufacturerData.readUInt16LE(0);
    return id === this.manufacturerId;
  }
}
