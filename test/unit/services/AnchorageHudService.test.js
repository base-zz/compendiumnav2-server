import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AnchorageHudService } from '../../../src/services/AnchorageHudService.js';

describe('AnchorageHudService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new AnchorageHudService({ dbPath: '/test/path.db' });
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('anchorage-hud');
      expect(service.type).to.equal('continuous');
    });

    it('should throw if options not provided', () => {
      expect(() => new AnchorageHudService()).to.throw('requires options');
    });

    it('should set dbPath from options', () => {
      expect(service.dbPath).to.equal('/test/path.db');
    });
  });

  describe('start()', () => {
    it('should call parent start', async () => {
      const parentStartStub = sandbox.stub(AnchorageHudService.prototype.__proto__, 'start').resolves();
      await service.start();
      expect(parentStartStub.calledOnce).to.be.true;
      parentStartStub.restore();
    });

    it('should throw if dbPath is not defined', async () => {
      service.dbPath = '';
      try { await service.start(); expect.fail(); } catch (e) { expect(e.message).to.include('ANCHORAGE_DB_PATH'); }
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(AnchorageHudService.prototype.__proto__, 'stop').resolves();
      service.isRunning = true;
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });

  describe('_toCardinalDirection()', () => {
    it('should convert degrees to cardinal direction', () => {
      expect(service._toCardinalDirection(0)).to.equal('N');
      expect(service._toCardinalDirection(90)).to.equal('E');
      expect(service._toCardinalDirection(180)).to.equal('S');
      expect(service._toCardinalDirection(270)).to.equal('W');
    });

    it('should return null for invalid input', () => {
      expect(service._toCardinalDirection(null)).to.be.null;
      expect(service._toCardinalDirection(NaN)).to.be.null;
    });
  });

  describe('_angularDifferenceDeg()', () => {
    it('should calculate angular difference', () => {
      expect(service._angularDifferenceDeg(0, 90)).to.equal(90);
      expect(service._angularDifferenceDeg(0, 180)).to.equal(180);
      expect(service._angularDifferenceDeg(350, 10)).to.equal(20);
    });

    it('should return 0 for invalid input', () => {
      expect(service._angularDifferenceDeg(null, 90)).to.equal(0);
    });
  });
});
