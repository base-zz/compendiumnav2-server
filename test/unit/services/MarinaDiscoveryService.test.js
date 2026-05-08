import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { MarinaDiscoveryService } from '../../../src/services/MarinaDiscoveryService.js';
import fs from 'fs/promises';

describe('MarinaDiscoveryService', () => {
  let service, sandbox;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    await fs.mkdir('/tmp/test-data', { recursive: true });
    service = new MarinaDiscoveryService({ dbPath: '/tmp/test-data/discovery.db' });
  });

  afterEach(async () => {
    sandbox.restore();
    try { await fs.rm('/tmp/test-data', { recursive: true, force: true }); } catch {}
  });

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('marina-discovery-service');
      expect(service.type).to.equal('continuous');
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(MarinaDiscoveryService.prototype.__proto__, 'start').resolves();
      await service.start();
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(MarinaDiscoveryService.prototype.__proto__, 'stop').resolves();
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
