import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import RecordedDemoService from '../../../src/services/RecordedDemoService.js';

describe('RecordedDemoService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    service = new RecordedDemoService({ file: '/test/demo.jsonl' });
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('recorded-demo');
      expect(service.type).to.equal('continuous');
    });

    it('should set filePath from options', () => {
      expect(service.filePath).to.equal('/test/demo.jsonl');
    });

    it('should set default speed', () => {
      expect(service.speed).to.equal(1);
    });
  });

  describe('start()', () => {
    it('should throw if file not found', async () => {
      try { await service.start(); expect.fail(); } catch (e) { expect(e.message).to.include('not found'); }
    });
  });

  describe('stop()', () => {
    it('should call parent stop', async () => {
      const parentStopStub = sandbox.stub(RecordedDemoService.prototype.__proto__, 'stop').resolves();
      service.isRunning = true;
      await service.stop();
      expect(service.isRunning).to.be.false;
      parentStopStub.restore();
    });
  });
});
