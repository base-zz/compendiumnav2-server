import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { MasterSyncService } from '../../../src/services/MasterSyncService.js';

describe('MasterSyncService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new MasterSyncService({ dbPath: '/test/path.db', vpsHost: 'https://test.com', boatId: 'test-boat', privateKey: 'test-key' });
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('master-sync');
      expect(service.type).to.equal('continuous');
    });

    it('should set dbPath from options', () => {
      expect(service.dbPath).to.equal('/test/path.db');
    });

    it('should set vpsHost from options', () => {
      expect(service.vpsHost).to.equal('https://test.com');
    });

    it('should throw if options not provided', () => {
      expect(() => new MasterSyncService()).to.throw('options is required');
    });

    it('should add https prefix to vpsHost if missing', () => {
      const s = new MasterSyncService({ dbPath: '/test.db', vpsHost: 'test.com', boatId: 'test-boat', privateKey: 'test-key' });
      expect(s.vpsHost).to.equal('https://test.com');
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(MasterSyncService.prototype.__proto__, 'start').resolves();
      await service.start();
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(MasterSyncService.prototype.__proto__, 'stop').resolves();
      service.isRunning = true;
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
