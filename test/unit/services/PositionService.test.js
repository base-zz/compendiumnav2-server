import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { PositionService } from '../../../src/services/PositionService.js';

describe('PositionService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new PositionService();
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('position-service');
      expect(service.type).to.equal('continuous');
    });

    it('should initialize with empty sources', () => {
      expect(service.sources).to.be.an('object');
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(PositionService.prototype.__proto__, 'start').resolves();
      await service.start();
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(PositionService.prototype.__proto__, 'stop').resolves();
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
