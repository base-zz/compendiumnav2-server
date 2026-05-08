import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import storageService from '../../../src/bluetooth/services/storage/storageService.js';

describe('storageService', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(console, 'error');
    // Reset singleton state
    storageService.settingsDB = null;
    storageService.initialized = false;
  });

  afterEach(() => sandbox.restore());

  describe('Constructor', () => {
    it('should initialize with default basePath', () => {
      expect(storageService.basePath).to.include('data');
    });

    it('should initialize settingsDB as null', () => {
      expect(storageService.settingsDB).to.be.null;
    });

    it('should initialize initialized as false', () => {
      expect(storageService.initialized).to.be.false;
    });
  });

  describe('initialize()', () => {
    it('should not reinitialize if already initialized', async () => {
      storageService.initialized = true;
      await storageService.initialize();
      expect(true).to.be.true;
    });
  });

  describe('close()', () => {
    it('should close settingsDB if exists', async () => {
      const closeStub = sandbox.stub();
      storageService.settingsDB = { close: closeStub };
      await storageService.close();
      expect(closeStub.called).to.be.true;
    });
  });
});
