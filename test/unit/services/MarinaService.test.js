import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { MarinaService } from '../../../src/services/MarinaService.js';

describe('MarinaService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new MarinaService({ dbPath: '/test/path.db' });
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('marina-hud');
      expect(service.type).to.equal('continuous');
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(MarinaService.prototype.__proto__, 'start').resolves();
      await service.start();
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(MarinaService.prototype.__proto__, 'stop').resolves();
      service.isRunning = true;
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
