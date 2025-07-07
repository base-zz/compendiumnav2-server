import PositionProvider from './PositionProvider.js';

/**
 * @class SignalKProvider
 * @description A position provider that gets its data from a SignalK source.
 * @extends PositionProvider
 */
export class SignalKPositionProvider extends PositionProvider {
  constructor() {
    // The name 'signalk' MUST match a key in the PositionService sources config.
    // It depends on the service that will provide the raw SignalK data.
    super('signalk-position-provider', ['state']);
    this._sourceService = null;
  }

  async start() {
    await super.start();
    this.log('Starting SignalK position provider...');

    this._sourceService = this.dependencies.state;
    if (!this._sourceService) {
      this.log('state dependency not met. Cannot provide position data.', 'warn');
      return;
    }

    // IMPORTANT: For this to work, we will later need to modify NewStateServiceDemo
    // to emit a 'sk-patch' event with its raw data. For now, we write the code
    // assuming that event will exist.
    this._handlePatch = this._handlePatch.bind(this);
    this._sourceService.on('sk-patch', this._handlePatch);

    this.log('SignalK position provider started and is listening for sk-patch events.');
  }

  async stop() {
    this.log('Stopping SignalK position provider...');
    if (this._sourceService) {
      this._sourceService.off('sk-patch', this._handlePatch);
    }
    await super.stop();
  }

  _handlePatch(patch) {
    // Use optional chaining for safety
    const position = patch?.vessels?.self?.navigation?.position;
    if (position && typeof position.latitude === 'number' && typeof position.longitude === 'number') {
      // We found position data, so we emit it in the common format.
      this._emitPosition({
        latitude: position.latitude,
        longitude: position.longitude
      });
    }
  }
}
