import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { BridgeHudService } from '../../../src/services/BridgeHudService.js';

describe('BridgeHudService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new BridgeHudService({ dbPath: '/test/path.db', boatId: 'test-boat' });
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('bridge-hud');
      expect(service.type).to.equal('continuous');
    });

    it('should set boatId from options', () => {
      expect(service.boatId).to.equal('test-boat');
    });

    it('should set dbPath from options', () => {
      expect(service.dbPath).to.equal('/test/path.db');
    });

    it('should set default safeAirDraft', () => {
      expect(service._safeAirDraft).to.equal(62.0);
    });

    it('should set default topSpeed', () => {
      expect(service._topSpeed).to.equal(7.0);
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(BridgeHudService.prototype.__proto__, 'start').resolves();
      await service.start();
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });

    it('should throw if dbPath is not defined', async () => {
      service.dbPath = null;
      try { await service.start(); expect.fail(); } catch (e) { expect(e.message).to.include('BRIDGE_DB_PATH'); }
    });

    it('should throw if StateManager is not available', async () => {
      const newService = new BridgeHudService({ dbPath: '/test/path.db', boatId: 'test-boat' });
      newService._stateManager = null;
      try { await newService.start(); } catch (e) { expect(e.message).to.include('StateManager instance'); }
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(BridgeHudService.prototype.__proto__, 'stop').resolves();
      service.isRunning = true;
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
