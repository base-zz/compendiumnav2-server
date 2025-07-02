import { EventEmitter } from 'events';
import { ParserRegistry } from '../bluetooth/parsers/ParserRegistry';
import { DeviceManager } from '../bluetooth/services/DeviceManager';

declare class BluetoothService extends EventEmitter {
  private scanning: boolean;
  private scanInterval: number;
  private scanTimer?: NodeJS.Timeout;
  private parserRegistry?: ParserRegistry;
  private deviceManager?: DeviceManager;
  private companyMap: Map<number, string>;
  private _shouldBeScanning: boolean;

  /**
   * @typedef {Object} DeviceFilterOptions
   * @property {number} [minRssi] - Minimum RSSI value for device discovery
   * @property {string[]|null} [allowedTypes] - Array of allowed device types (null = all types)
   */

  /**
   * @typedef {Object} BluetoothServiceOptions
   */
  constructor(options?: {
    scanDuration?: number;
    scanInterval?: number;
    ymlPath?: string;
    filters?: {
      minRssi?: number;
      allowedTypes?: string[] | null;
    };
    autoSelectRuuvi?: boolean;
    debug?: boolean;
    logLevel?: string;
    parserRegistry?: ParserRegistry;
    deviceManager?: DeviceManager;
    stateManager?: any; // StateManager instance
  });

  // Lifecycle methods
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;

  // Scanning methods
  startScanning(): Promise<boolean>;
  stopScanning(): Promise<boolean>;
  isScanning(): boolean;

  // Device management
  getDevices(): any[];
  getSelectedDevices(): any[];
  getConnectedDevices(): any[];
  getDevicesByType(type: string): any[];
  updateDeviceMetadata(deviceId: string, metadata: any): Promise<void>;
  updateDeviceName(deviceId: string, name: string): Promise<void>;
  updateDeviceType(deviceId: string, type: string): Promise<void>;
  updateDeviceRSSI(deviceId: string, rssi: number): Promise<void>;

  // Event handler properties
  private _onDiscover: (peripheral: any) => void;
  private _onStateChange: (state: string) => void;
  private _onScanStart: () => void;
  private _onScanStop: () => void;
  
  /**
   * Handle BLE device discovery
   * @param peripheral - The discovered BLE peripheral
   * @private
   */
  private _handleDeviceDiscovery(peripheral: any): void;
  
  /**
   * Handle BLE state change events
   * @param state - The new BLE state
   * @private
   */
  private _handleStateChange(state: string): void;
  
  /**
   * Handle scan start events
   * @private
   */
  private _handleScanStart(): void;
  
  /**
   * Handle scan stop events
   * @private
   */
  private _handleScanStop(): void;

  // Helper methods
  private _initNoble(): Promise<void>;
  private _setupNobleListeners(): void;
  private _removeNobleListeners(): void;
  private _startScan(): Promise<boolean>;
  private _stopScan(): Promise<boolean>;
  private _startScanCycle(): Promise<void>;
  private _parseManufacturerData(data: Buffer): any;
  private _determineDeviceType(peripheral: any): string;
  private _loadCompanyIdentifiers(): Promise<void>;
  private _getCompanyName(id: number): string | undefined;
  private _getCompanyId(name: string): number | undefined;
  private _getCompanyNames(): string[];
  private _getCompanyIds(): number[];
  private _getCompanyMap(): Map<number, string>;
  private _getParserRegistry(): ParserRegistry | undefined;
  private _getDeviceManager(): DeviceManager | undefined;
  private _log(message: string, level?: string): void;
}

export { BluetoothService };
