/**
 * ConfigurableParser - A generic parser that uses JSON configuration
 * to parse Bluetooth manufacturer data
 */
class ConfigurableParser {
  constructor(config) {
    this.config = config;
    this.manufacturerId = config.manufacturerId;
    this.name = config.name || `Parser_${config.manufacturerId.toString(16)}`;
  }

  /**
   * Parse manufacturer data using the configuration
   * @param {Buffer} data - Raw manufacturer data (including manufacturer ID)
   * @returns {Object|null} Parsed data or null if invalid
   */
  parse(data) {
    if (!data || data.length < 2) return null;

    // Skip manufacturer ID (first 2 bytes)
    const payload = data.slice(2);
    if (payload.length < 1) return null;

    // Check if we need to determine format version
    let formatConfig = null;
    
    if (this.config.formats && this.config.formats.length > 0) {
      // If there's a formatField specified, use it to determine which format to use
      if (this.config.formatField) {
        const formatValue = this._readField(payload, this.config.formatField);
        formatConfig = this.config.formats.find(f => f.version === formatValue);
      } else {
        // Use the first (or only) format
        formatConfig = this.config.formats[0];
      }
    }

    if (!formatConfig) {
      console.warn(`No format configuration found for ${this.name}`);
      return null;
    }

    // Validate minimum length
    if (payload.length < (formatConfig.minLength || 0)) {
      console.warn(`Payload too short for ${this.name} format ${formatConfig.version}`);
      return null;
    }

    // Parse all fields
    const result = {
      format: formatConfig.formatName || this.name,
      dataFormat: formatConfig.version,
      raw: data.toString('hex')
    };

    for (const field of formatConfig.fields) {
      const value = this._readField(payload, field);
      
      // Build nested structure based on field path
      const path = field.name.split('.');
      let current = result;
      
      for (let i = 0; i < path.length - 1; i++) {
        if (!current[path[i]]) {
          current[path[i]] = {};
        }
        current = current[path[i]];
      }
      
      const finalKey = path[path.length - 1];
      
      // If field has a unit, create an object with value and unit
      if (field.unit) {
        current[finalKey] = {
          value: value,
          unit: field.unit
        };
        
        // Add derived fields if specified
        if (field.derived) {
          for (const derivedField of field.derived) {
            const derivedValue = this._calculateDerived(value, derivedField);
            current[finalKey][derivedField.name] = derivedValue;
          }
        }
      } else {
        current[finalKey] = value;
      }
    }

    return result;
  }

  /**
   * Read a field from the payload based on field configuration
   * @private
   */
  _readField(payload, field) {
    const { offset, length, type, scale, transform, endian = 'BE' } = field;

    if (offset + length > payload.length) {
      return null;
    }

    let rawValue;

    // Read the raw value based on type
    switch (type) {
      case 'int8':
        rawValue = payload.readInt8(offset);
        break;
      case 'uint8':
        rawValue = payload.readUInt8(offset);
        break;
      case 'int16':
        rawValue = endian === 'BE' 
          ? payload.readInt16BE(offset)
          : payload.readInt16LE(offset);
        break;
      case 'uint16':
        rawValue = endian === 'BE'
          ? payload.readUInt16BE(offset)
          : payload.readUInt16LE(offset);
        break;
      case 'int32':
        rawValue = endian === 'BE'
          ? payload.readInt32BE(offset)
          : payload.readInt32LE(offset);
        break;
      case 'uint32':
        rawValue = endian === 'BE'
          ? payload.readUInt32BE(offset)
          : payload.readUInt32LE(offset);
        break;
      case 'buffer':
        rawValue = payload.slice(offset, offset + length);
        break;
      case 'string':
        rawValue = payload.slice(offset, offset + length).toString('utf8');
        break;
      case 'hex':
        rawValue = payload.slice(offset, offset + length).toString('hex').toUpperCase();
        break;
      case 'mac':
        const macHex = payload.slice(offset, offset + length).toString('hex').toUpperCase();
        rawValue = macHex.match(/.{1,2}/g).join(':');
        break;
      case 'bitfield':
        // For bitfield, we need to extract specific bits
        rawValue = this._readBitfield(payload, field);
        break;
      case 'composite':
        // For composite fields (e.g., temperature with integral and fractional parts)
        rawValue = this._readComposite(payload, field);
        break;
      default:
        console.warn(`Unknown field type: ${type}`);
        return null;
    }

    // Apply scale if specified
    if (scale !== undefined && typeof rawValue === 'number') {
      rawValue = rawValue * scale;
    }

    // Apply transform if specified
    if (transform) {
      rawValue = this._applyTransform(rawValue, transform);
    }

    return rawValue;
  }

  /**
   * Read a bitfield value
   * @private
   */
  _readBitfield(payload, field) {
    const { offset, bitOffset = 0, bitLength = 8 } = field;
    
    // Read the byte(s) containing the bitfield
    let value;
    if (bitLength <= 8) {
      value = payload.readUInt8(offset);
    } else if (bitLength <= 16) {
      value = payload.readUInt16BE(offset);
    } else {
      value = payload.readUInt32BE(offset);
    }
    
    // Extract the bits
    const mask = (1 << bitLength) - 1;
    return (value >> bitOffset) & mask;
  }

  /**
   * Read a composite value (e.g., temperature with integral and fractional parts)
   * @private
   */
  _readComposite(payload, field) {
    const { parts } = field;
    let result = 0;
    
    for (const part of parts) {
      const partValue = this._readField(payload, part);
      result += partValue * (part.multiplier || 1);
    }
    
    return result;
  }

  /**
   * Apply a transformation to a value
   * @private
   */
  _applyTransform(value, transform) {
    switch (transform.type) {
      case 'add':
        return value + transform.value;
      case 'multiply':
        return value * transform.value;
      case 'divide':
        return value / transform.value;
      case 'formula':
        // Support simple formulas like "x * 9/5 + 32"
        // For safety, we'll use a limited eval-like approach
        return this._evaluateFormula(value, transform.formula);
      default:
        return value;
    }
  }

  /**
   * Evaluate a simple formula
   * @private
   */
  _evaluateFormula(x, formula) {
    try {
      // Very basic formula evaluation - only supports x, numbers, and basic operators
      // This is safer than eval() but still limited
      const sanitized = formula.replace(/[^x0-9+\-*/().\s]/g, '');
      return Function('x', `return ${sanitized}`)(x);
    } catch (error) {
      console.warn(`Failed to evaluate formula: ${formula}`, error);
      return x;
    }
  }

  /**
   * Calculate a derived field value
   * @private
   */
  _calculateDerived(baseValue, derivedConfig) {
    if (derivedConfig.formula) {
      return this._evaluateFormula(baseValue, derivedConfig.formula);
    }
    
    if (derivedConfig.transform) {
      return this._applyTransform(baseValue, derivedConfig.transform);
    }
    
    return baseValue;
  }

  /**
   * Check if this parser can handle the given manufacturer data
   */
  matches(manufacturerData) {
    return manufacturerData?.length >= 2 && 
           manufacturerData.readUInt16LE(0) === this.manufacturerId;
  }
}

export default ConfigurableParser;
