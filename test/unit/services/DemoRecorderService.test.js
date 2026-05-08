import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import DemoRecorderService from '../../../src/services/DemoRecorderService.js';
import fs from 'fs/promises';

describe('DemoRecorderService', () => {
  let service, sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    sandbox.stub(fs, 'mkdir').resolves();
    sandbox.stub(fs, 'access').resolves();
    sandbox.stub(fs, 'open').resolves({ close: sandbox.stub() });
    sandbox.stub(fs, 'writeFile').resolves();
    service = new DemoRecorderService({ outputDir: '/test/recordings' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor', () => {
    it('should initialize with correct name and type', () => {
      expect(service.name).to.equal('demo-recorder');
      expect(service.type).to.equal('continuous');
    });

    it('should set outputDir from options', () => {
      expect(service.outputDir).to.equal('/test/recordings');
    });

    it('should set default events to record', () => {
      expect(service.eventsToRecord).to.include('state:patch');
      expect(service.eventsToRecord).to.include('victron:update');
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
      const parentStopStub = sandbox.stub(DemoRecorderService.prototype.__proto__, 'stop').resolves();
      service.isRunning = true;
      await service.stop();
      expect(parentStopStub.calledOnce).to.be.true;
      parentStopStub.restore();
    });
  });
});
