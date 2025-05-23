/**
 * Unit Conversion Module
 * 
 * This module provides utilities for converting between different units
 * used throughout the application.
 */

// Conversion functions
export const UnitConversion = {
  // Length conversions
  mToFt: (m) => m !== null ? Math.round(m * 3.28084 * 10) / 10 : null,
  ftToM: (ft) => ft !== null ? Math.round(ft / 3.28084 * 10) / 10 : null,
  mToNm: (m) => m !== null ? Math.round(m / 1852 * 10) / 10 : null,
  nmToM: (nm) => nm !== null ? Math.round(nm * 1852 * 10) / 10 : null,
  ftToNm: (ft) => ft !== null ? Math.round((ft / 3.28084) / 1852 * 10) / 10 : null,
  nmToFt: (nm) => nm !== null ? Math.round(nm * 1852 * 3.28084 * 10) / 10 : null,
  
  // Speed conversions
  mpsToKts: (mps) => mps !== null ? Math.round(mps * 1.94384 * 10) / 10 : null,
  ktsToMps: (kts) => kts !== null ? Math.round(kts / 1.94384 * 10) / 10 : null,
  mpsToKmh: (mps) => mps !== null ? Math.round(mps * 3.6 * 10) / 10 : null,
  kmhToMps: (kmh) => kmh !== null ? Math.round(kmh / 3.6 * 10) / 10 : null,
  ktsToKmh: (kts) => kts !== null ? Math.round(kts * 1.852 * 10) / 10 : null,
  kmhToKts: (kmh) => kmh !== null ? Math.round(kmh / 1.852 * 10) / 10 : null,
  ktsToMph: (kts) => kts !== null ? Math.round(kts * 1.15078 * 10) / 10 : null,
  mphToKts: (mph) => mph !== null ? Math.round(mph / 1.15078 * 10) / 10 : null,
  
  // Temperature conversions
  cToF: (c) => c !== null ? Math.round((c * 9/5 + 32) * 10) / 10 : null,
  fToC: (f) => f !== null ? Math.round((f - 32) * 5/9 * 10) / 10 : null,
  
  // Pressure conversions
  paToHpa: (pa) => pa !== null ? Math.round(pa / 100 * 10) / 10 : null,
  hpaToPa: (hpa) => hpa !== null ? hpa * 100 : null,
  paToInHg: (pa) => pa !== null ? Math.round(pa / 3386.39 * 100) / 100 : null,
  inHgToPa: (inHg) => inHg !== null ? inHg * 3386.39 : null,
  hpaToInHg: (hpa) => hpa !== null ? Math.round(hpa / 33.8639 * 100) / 100 : null,
  inHgToHpa: (inHg) => inHg !== null ? Math.round(inHg * 33.8639 * 10) / 10 : null,
  hpaToMb: (hpa) => hpa, // They are the same
  mbToHpa: (mb) => mb, // They are the same
  
  // Volume conversions
  lToGal: (l) => l !== null ? Math.round(l * 0.264172 * 10) / 10 : null,
  galToL: (gal) => gal !== null ? Math.round(gal / 0.264172 * 10) / 10 : null,
  
  // Angle conversions
  radToDeg: (rad) => {
    if (rad === null) return null;
    // Convert to degrees and normalize to 0-360
    const degrees = Math.round(rad * (180 / Math.PI) * 10) / 10;
    return ((degrees % 360) + 360) % 360;
  },
  degToRad: (deg) => deg !== null ? deg * (Math.PI / 180) : null,
  
  // Normalize angle to 0-360 degree range
  normalizeDegrees: (degrees) => {
    if (degrees === null) return null;
    // Ensure the angle is within 0-360 range
    return ((degrees % 360) + 360) % 360;
  },
  
  // Normalize angle to 0-2π radian range
  normalizeRadians: (radians) => {
    if (radians === null) return null;
    const TWO_PI = 2 * Math.PI;
    // Ensure the angle is within 0-2π range
    return ((radians % TWO_PI) + TWO_PI) % TWO_PI;
  },
  
  // Convert a value from one unit to another
  convert(value, fromUnit, toUnit) {
    if (value === null || fromUnit === toUnit) return value;
    
    // Define conversion paths
    const conversionMap = {
      // Length
      'm->ft': this.mToFt,
      'ft->m': this.ftToM,
      'm->nm': this.mToNm,
      'nm->m': this.nmToM,
      'ft->nm': this.ftToNm,
      'nm->ft': this.nmToFt,
      
      // Speed
      'm/s->kts': this.mpsToKts,
      'kts->m/s': this.ktsToMps,
      'm/s->km/h': this.mpsToKmh,
      'km/h->m/s': this.kmhToMps,
      'kts->km/h': this.ktsToKmh,
      'km/h->kts': this.kmhToKts,
      'kts->mph': this.ktsToMph,
      'mph->kts': this.mphToKts,
      'm/s->mph': (mps) => this.ktsToMph(this.mpsToKts(mps)),
      'mph->m/s': (mph) => this.ktsToMps(this.mphToKts(mph)),
      'km/h->mph': (kmh) => this.ktsToMph(this.kmhToKts(kmh)),
      'mph->km/h': (mph) => this.ktsToKmh(this.mphToKts(mph)),
      
      // Temperature
      '°C->°F': this.cToF,
      '°F->°C': this.fToC,
      
      // Pressure
      'Pa->hPa': this.paToHpa,
      'hPa->Pa': this.hpaToPa,
      'Pa->inHg': this.paToInHg,
      'inHg->Pa': this.inHgToPa,
      'hPa->inHg': this.hpaToInHg,
      'inHg->hPa': this.inHgToHpa,
      'hPa->mb': this.hpaToMb,
      'mb->hPa': this.mbToHpa,
      'Pa->mb': (pa) => this.hpaToMb(this.paToHpa(pa)),
      'mb->Pa': (mb) => this.hpaToPa(this.mbToHpa(mb)),
      'inHg->mb': (inHg) => this.hpaToMb(this.inHgToHpa(inHg)),
      'mb->inHg': (mb) => this.hpaToInHg(this.mbToHpa(mb)),
      
      // Volume
      'L->gal': this.lToGal,
      'gal->L': this.galToL,
      
      // Angle
      'rad->deg': this.radToDeg,
      'deg->rad': this.degToRad
    };
    
    const conversionKey = `${fromUnit}->${toUnit}`;
    if (conversionMap[conversionKey]) {
      return conversionMap[conversionKey](value);
    }
    
    console.error(`No conversion found from ${fromUnit} to ${toUnit}`);
    return value;
  },
  
  // Get the base unit for a given unit type (used for internal storage)
  getBaseUnit(unitType) {
    const baseUnits = {
      'length': 'm',
      'speed': 'm/s',
      'temperature': '°C',
      'pressure': 'Pa',
      'volume': 'L',
      'angle': 'rad'
    };
    
    return baseUnits[unitType] || null;
  },
  
  // Get the unit type for a given unit
  getUnitType(unit) {
    const unitToType = {
      'm': 'length',
      'ft': 'length',
      'nm': 'length',
      'm/s': 'speed',
      'kts': 'speed',
      'km/h': 'speed',
      'mph': 'speed',
      '°C': 'temperature',
      '°F': 'temperature',
      'Pa': 'pressure',
      'hPa': 'pressure',
      'inHg': 'pressure',
      'mb': 'pressure',
      'L': 'volume',
      'gal': 'volume',
      'rad': 'angle',
      'deg': 'angle'
    };
    
    return unitToType[unit] || null;
  },
  
  // Convert to base unit (for internal storage)
  convertToBaseUnit(value, fromUnit) {
    if (value === null) return null;
    
    const unitType = this.getUnitType(fromUnit);
    if (!unitType) {
      console.error(`Unknown unit type for: ${fromUnit}`);
      return value;
    }
    
    const baseUnit = this.getBaseUnit(unitType);
    return this.convert(value, fromUnit, baseUnit);
  },
  
  // Convert from base unit to display unit
  convertFromBaseUnit(value, toUnit) {
    if (value === null) return null;
    
    const unitType = this.getUnitType(toUnit);
    if (!unitType) {
      console.error(`Unknown unit type for: ${toUnit}`);
      return value;
    }
    
    const baseUnit = this.getBaseUnit(unitType);
    return this.convert(value, baseUnit, toUnit);
  }
};
