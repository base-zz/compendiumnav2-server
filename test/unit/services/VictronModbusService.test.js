import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { VictronModbusService } from '../../../src/services/VictronModbusService.js';
import storageService from '../../../src/bluetooth/services/storage/storageService.js';

describe('VictronModbusService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    // Stub storageService methods to avoid initialization errors
    sandbox.stub(storageService, 'initialize').resolves();
    sandbox.stub(storageService, 'setSetting').resolves();
    sandbox.stub(storageService, 'getSetting').resolves();
    service = new VictronModbusService({ host: '192.168.50.158', port: 502 });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('victron-modbus');
      expect(service.type).to.equal('continuous');
    });

    it('should set host from options', () => {
      expect(service.host).to.equal('192.168.50.158');
    });

    it('should set port from options', () => {
      expect(service.port).to.equal(502);
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(VictronModbusService.prototype.__proto__, 'start').resolves();
      sandbox.stub(service, '_connect').resolves();
      sandbox.stub(service, '_discoverDevices').resolves();
      await service.start();
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(VictronModbusService.prototype.__proto__, 'stop').resolves();
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
