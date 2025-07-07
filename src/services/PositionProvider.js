import BaseService from './BaseService.js';

/**
 * @class PositionProvider
 * @description A base class for services that parse data from a specific source
 * (e.g., SignalK, NMEA0183) and provide standardized position updates.
 * This class is intended to be extended, not instantiated directly.
 * @extends BaseService
 */
export class PositionProvider extends BaseService {
  constructor(name, dependencies = []) {
    super(name, 'position-provider'); // Call BaseService constructor correctly

    // Dependencies are set on the instance, not passed to super()
    this._dependencies = dependencies;

    // Flag for PositionService to automatically discover this provider
    this.providesPosition = true;
  }

  /**
   * The common format for position data that all providers must emit.
   * @typedef {object} PositionData
   * @property {number} latitude - Latitude in decimal degrees.
   * @property {number} longitude - Longitude in decimal degrees.
   */

  /**
   * Emits a standardized position update.
   * @param {PositionData} position - The position data in the common format.
   * @protected
   */
  _emitPosition(position) {
    if (position && typeof position.latitude === 'number' && typeof position.longitude === 'number') {
      this.emit('position:update', position);
    } else {
      this.log('Attempted to emit invalid or incomplete position data.', 'warn');
    }
  }

  // Extending classes must implement their own start() method to hook into their
  // specific raw data source and call _emitPosition() with the parsed data.
}

export default PositionProvider;
