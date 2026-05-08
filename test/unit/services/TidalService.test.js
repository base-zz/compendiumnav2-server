import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { TidalService } from '../../../src/services/TidalService.js';

describe('TidalService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new TidalService();
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('tidal');
      expect(service.type).to.equal('scheduled');
    });
  });

  describe('start()', () => {
    it('should require state service', async () => {
      try {
        await service.start();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.include('state');
      }
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(TidalService.prototype.__proto__, 'stop').resolves();
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
