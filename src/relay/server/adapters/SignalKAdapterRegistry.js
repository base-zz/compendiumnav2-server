/**
 * SignalKAdapterRegistry
 * 
 * Registry for SignalK format adapters that can be used to handle different SignalK implementations.
 */
import { StandardSignalKAdapter } from './StandardSignalKAdapter.js';
import { OpenPlotterSignalKAdapter } from './OpenPlotterSignalKAdapter.js';
import { DemoSignalKAdapter } from './DemoSignalKAdapter.js';

export class SignalKAdapterRegistry {
  constructor() {
    this.adapters = [];
    this.defaultAdapter = null;
    
    // Register built-in adapters
    this.registerAdapter(new OpenPlotterSignalKAdapter());
    this.registerAdapter(new DemoSignalKAdapter());
    
    // Always register the standard adapter last as a fallback
    const standardAdapter = new StandardSignalKAdapter();
    this.registerAdapter(standardAdapter);
    this.defaultAdapter = standardAdapter;
  }

  /**
   * Register a new adapter
   * @param {BaseSignalKAdapter} adapter - The adapter to register
   */
  registerAdapter(adapter) {
    this.adapters.push(adapter);
  }

  /**
   * Find the appropriate adapter for a SignalK server
   * @param {Object} serverInfo - Server information from initial connection
   * @returns {BaseSignalKAdapter} - The appropriate adapter
   */
  findAdapter(serverInfo) {
    // Try to find an adapter that can handle this server
    for (const adapter of this.adapters) {
      if (adapter.canHandle(serverInfo)) {
        // console.log(`[SignalKAdapterRegistry] Found adapter: ${adapter.constructor.name}`);
        return adapter;
      }
    }
    
    // Fall back to the default adapter
    // console.log(`[SignalKAdapterRegistry] Using default adapter: ${this.defaultAdapter.constructor.name}`);
    return this.defaultAdapter;
  }

  /**
   * Get an adapter by name
   * @param {String} name - The name of the adapter
   * @returns {BaseSignalKAdapter|null} - The adapter or null if not found
   */
  getAdapterByName(name) {
    for (const adapter of this.adapters) {
      if (adapter.constructor.name === name) {
        return adapter;
      }
    }
    return null;
  }

  /**
   * Get all registered adapters
   * @returns {Array<BaseSignalKAdapter>} - All registered adapters
   */
  getAllAdapters() {
    return [...this.adapters];
  }
}

// Create singleton instance
export const signalKAdapterRegistry = new SignalKAdapterRegistry();
