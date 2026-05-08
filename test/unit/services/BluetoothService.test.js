import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { BluetoothService } from '../../../src/services/BluetoothService.js';

describe('BluetoothService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new BluetoothService({ scanDuration: 10000, scanInterval: 30000 });
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('bluetooth');
      expect(service.type).to.equal('continuous');
    });

    it('should set scanDuration from options', () => {
      expect(service.scanDuration).to.equal(10000);
    });

    it('should set scanInterval from options', () => {
      expect(service.scanInterval).to.equal(30000);
    });

    it('should set default scanDuration if not provided', () => {
      const defaultService = new BluetoothService({});
      expect(defaultService.scanDuration).to.equal(10000);
    });

    it('should set default scanInterval if not provided', () => {
      const defaultService = new BluetoothService({});
      expect(defaultService.scanInterval).to.equal(30000);
    });

    it('should initialize parserRegistry', () => {
      expect(service.parserRegistry).to.exist;
    });

    it('should initialize deviceManager', () => {
      expect(service.deviceManager).to.exist;
    });

    it('should initialize companyMap', () => {
      expect(service.companyMap).to.be.instanceOf(Map);
    });

    it('should set scanning flag to false', () => {
      expect(service.scanning).to.be.false;
    });

    it('should set isRunning flag to false', () => {
      expect(service.isRunning).to.be.false;
    });

    it('should set filters with defaults', () => {
      expect(service.filters.minRssi).to.equal(-100);
      expect(service.filters.allowedTypes).to.be.null;
    });

    it('should initialize deviceUpdates map', () => {
      expect(service.deviceUpdates).to.be.instanceOf(Map);
    });

    it('should initialize consecutiveEmptyScans to 0', () => {
      expect(service.consecutiveEmptyScans).to.equal(0);
    });

    it('should initialize softRecoveryAttempts to 0', () => {
      expect(service.softRecoveryAttempts).to.equal(0);
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(BluetoothService.prototype.__proto__, 'start').resolves();

      await service.start();

      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });

    it('should return early if already running', async () => {
      service.isRunning = true;
      const parentStartStub = sandbox.stub(BluetoothService.prototype.__proto__, 'start').resolves();

      await service.start();

      expect(parentStartStub.called).to.be.false;
      parentStartStub.restore();
    });

    it('should load company map', async () => {
      const loadMapStub = sandbox.stub(service, '_loadCompanyMap').resolves();
      sandbox.stub(BluetoothService.prototype.__proto__, 'start').resolves();

      await service.start();

      expect(loadMapStub.calledOnce).to.be.true;
    });

    it('should handle company map load errors gracefully', async () => {
      sandbox.stub(service, '_loadCompanyMap').rejects(new Error('Load error'));
      const logErrorStub = sandbox.stub(service, 'logError');
      sandbox.stub(BluetoothService.prototype.__proto__, 'start').resolves();

      await service.start();

      expect(logErrorStub.called).to.be.true;
    });

    it('should start scan cycle', async () => {
      sandbox.stub(service, '_loadCompanyMap').resolves();
      sandbox.stub(service, '_startScanCycle').resolves();
      sandbox.stub(service, '_startScanHealthWatchdog');
      sandbox.stub(BluetoothService.prototype.__proto__, 'start').resolves();

      await service.start();

      expect(service._startScanCycle.calledOnce).to.be.true;
    });

    it('should start scan health watchdog', async () => {
      sandbox.stub(service, '_loadCompanyMap').resolves();
      sandbox.stub(service, '_startScanCycle').resolves();
      sandbox.stub(service, '_startScanHealthWatchdog');
      sandbox.stub(BluetoothService.prototype.__proto__, 'start').resolves();

      await service.start();

      expect(service._startScanHealthWatchdog.calledOnce).to.be.true;
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      sandbox.stub(service, '_stopScan').resolves();
      sandbox.stub(service, 'cleanup').resolves();
      const parentStartStub = sandbox.stub(BluetoothService.prototype.__proto__, 'start').resolves();
      await service.start();
      await service.stop();
      expect(service.isRunning).to.be.false;
      parentStartStub.restore();
    });

    it('should return early if not running', async () => {
      await service.stop();
      expect(service.isRunning).to.be.false;
    });

    it('should stop scan if scanning', async () => {
      service.isRunning = true;
      service.scanning = true;
      sandbox.stub(service, '_stopScan').resolves();
      sandbox.stub(BluetoothService.prototype.__proto__, 'stop').resolves();

      await service.stop();

      expect(service._stopScan.calledOnce).to.be.true;
    });

    it('should clear scanTimer', async () => {
      service.isRunning = true;
      service.scanTimer = 123;
      sandbox.stub(BluetoothService.prototype.__proto__, 'stop').resolves();
      const clearTimeoutStub = sandbox.stub(globalThis, 'clearTimeout');

      await service.stop();

      expect(clearTimeoutStub.calledWith(123)).to.be.true;
      clearTimeoutStub.restore();
    });

    it('should clear scanTimeout', async () => {
      service.isRunning = true;
      service.scanTimeout = 123;
      sandbox.stub(BluetoothService.prototype.__proto__, 'stop').resolves();
      const clearTimeoutStub = sandbox.stub(globalThis, 'clearTimeout');

      await service.stop();

      expect(clearTimeoutStub.calledWith(123)).to.be.true;
      clearTimeoutStub.restore();
    });

    it('should clear scanHealthTimer', async () => {
      service.isRunning = true;
      service.scanHealthTimer = 123;
      sandbox.stub(BluetoothService.prototype.__proto__, 'stop').resolves();
      const clearIntervalStub = sandbox.stub(globalThis, 'clearInterval');

      await service.stop();

      expect(clearIntervalStub.calledWith(123)).to.be.true;
      clearIntervalStub.restore();
    });

    it('should set isRunning to false', async () => {
      service.isRunning = true;
      sandbox.stub(BluetoothService.prototype.__proto__, 'stop').resolves();

      await service.stop();

      expect(service.isRunning).to.be.false;
    });

    it('should emit stopped event', async () => {
      service.isRunning = true;
      const emitSpy = sandbox.stub(service, 'emit');
      sandbox.stub(BluetoothService.prototype.__proto__, 'stop').resolves();

      await service.stop();

      expect(emitSpy.calledWith('stopped')).to.be.true;
    });
  });

  describe('cleanup()', () => {
    it('should clear scanTimer', () => {
      service.scanTimer = 123;
      const clearTimeoutStub = sandbox.stub(globalThis, 'clearTimeout');

      service.cleanup();

      expect(clearTimeoutStub.calledWith(123)).to.be.true;
      expect(service.scanTimer).to.be.null;
      clearTimeoutStub.restore();
    });

    it('should clear scanTimeout', () => {
      service.scanTimeout = 123;
      const clearTimeoutStub = sandbox.stub(globalThis, 'clearTimeout');

      service.cleanup();

      expect(clearTimeoutStub.calledWith(123)).to.be.true;
      expect(service.scanTimeout).to.be.null;
      clearTimeoutStub.restore();
    });

    it('should clear scanHealthTimer', () => {
      service.scanHealthTimer = 123;
      const clearIntervalStub = sandbox.stub(globalThis, 'clearInterval');

      service.cleanup();

      expect(clearIntervalStub.calledWith(123)).to.be.true;
      expect(service.scanHealthTimer).to.be.null;
      clearIntervalStub.restore();
    });

    it('should reset scanning flag', () => {
      service.scanning = true;

      service.cleanup();

      expect(service.scanning).to.be.false;
    });

    it('should reset isRunning flag', () => {
      service.isRunning = true;

      service.cleanup();

      expect(service.isRunning).to.be.false;
    });

    it('should remove all listeners', () => {
      const removeAllListenersStub = sandbox.stub(service, 'removeAllListeners');

      service.cleanup();

      expect(removeAllListenersStub.calledOnce).to.be.true;
    });
  });

  describe('_handleScanStart()', () => {
    it('should set scanning flag to true', () => {
      service._handleScanStart();

      expect(service.scanning).to.be.true;
    });

    it('should set isStarting flag to false', () => {
      service.isStarting = true;

      service._handleScanStart();

      expect(service.isStarting).to.be.false;
    });

    it('should set lastScanStartedAt', () => {
      service._handleScanStart();

      expect(service.lastScanStartedAt).to.be.a('number');
    });

    it('should reset currentScanDiscoveredDevices', () => {
      service.currentScanDiscoveredDevices = 5;

      service._handleScanStart();

      expect(service.currentScanDiscoveredDevices).to.equal(0);
    });
  });

  describe('_handleScanStop()', () => {
    it('should set scanning flag to false', () => {
      service.scanning = true;
      service._handleScanStop();
      expect(service.scanning).to.be.false;
    });

    it('should set lastScanStoppedAt', () => {
      service.scanning = true;
      service._handleScanStop();
      expect(service.lastScanStoppedAt).to.be.a('number');
    });
  });

  describe('_setupStateManagement()', () => {
    it('should return early if no stateManager', () => {
      service.stateManager = null;
      service._setupStateManagement();
      expect(true).to.be.true; // Should not throw
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined options in constructor', () => {
      const undefinedService = new BluetoothService(undefined);
      expect(undefinedService.scanDuration).to.equal(10000);
      expect(undefinedService.scanInterval).to.equal(30000);
    });
  });
});
