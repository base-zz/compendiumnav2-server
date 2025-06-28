import fs from 'fs';
import { ConfigLoader } from './loader';
import { createTempConfigFile, cleanupTempFiles, sampleConfig } from '../__tests__/test-utils';

// This tells TypeScript to treat this as a module
export {};

describe('ConfigLoader', () => {
  let tempConfigPath: string;
  let loader: ConfigLoader;

  // Setup before all tests
  beforeAll(() => {
    // Create a temporary config file for testing
    tempConfigPath = createTempConfigFile(sampleConfig);
    
    // Mock process.env.BTMAN_CONFIG
    process.env.BTMAN_CONFIG = tempConfigPath;
  });

  // Cleanup after all tests
  afterAll(() => {
    delete process.env.BTMAN_CONFIG;
    cleanupTempFiles();
  });

  // Create a new loader instance before each test
  beforeEach(() => {
    // Clear the singleton instance
    (ConfigLoader as any).instance = undefined;
    loader = ConfigLoader.getInstance();
  });

  describe('loadConfig', () => {
    it('should load configuration from the specified path', () => {
      const companies = loader.getAllCompanies();
      expect(companies).toHaveLength(4);
      expect(companies[0].name).toBe('Test Company 1');
      expect(companies[0].id).toBe(0x1234);
    });

    it('should handle non-existent config file', () => {
      process.env.BTMAN_CONFIG = '/non/existent/path.yml';
      (ConfigLoader as any).instance = undefined;
      
      const consoleWarnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
      
      expect(() => {
        loader = ConfigLoader.getInstance();
      }).not.toThrow();
      
      expect(consoleWarnMock).toHaveBeenCalledWith(
        expect.stringContaining('Config file not found at')
      );
      
      consoleWarnMock.mockRestore();
    });
  });

  describe('getCompanyName', () => {
    it('should return the correct company name for a given ID', () => {
      expect(loader.getCompanyName(0x1234)).toBe('Test Company 1');
      expect(loader.getCompanyName(0x5678)).toBe('Test Company 2');
      expect(loader.getCompanyName(0x9abc)).toBe('Test Company 3');
      expect(loader.getCompanyName(12345)).toBe('Test Company 4');
    });

    it('should handle non-existent company IDs', () => {
      expect(loader.getCompanyName(0x9999)).toBeUndefined();
    });
  });

  describe('getCompanyId', () => {
    it('should return the correct company ID for a given name', () => {
      expect(loader.getCompanyId('Test Company 1')).toBe(0x1234);
      expect(loader.getCompanyId('Test Company 2')).toBe(0x5678);
      expect(loader.getCompanyId('Test Company 3')).toBe(0x9abc);
      expect(loader.getCompanyId('Test Company 4')).toBe(12345);
    });

    it('should handle non-existent company names', () => {
      expect(loader.getCompanyId('Non Existent Company')).toBeUndefined();
    });
  });

  describe('reload', () => {
    it('should reload the configuration', () => {
      const initialCount = loader.getAllCompanies().length;
      
      // Modify the config file
      const newConfig = sampleConfig + '\n  - value: 0xDEAD\n    name: \'New Test Company\'';
      fs.writeFileSync(tempConfigPath, newConfig, 'utf8');
      
      // Reload and verify
      loader.reload();
      const newCount = loader.getAllCompanies().length;
      
      expect(newCount).toBe(initialCount + 1);
      expect(loader.getCompanyName(0xdead)).toBe('New Test Company');
    });
  });

  describe('getAllCompanies', () => {
    it('should return all companies in the config', () => {
      const companies = loader.getAllCompanies();
      expect(companies).toEqual([
        { id: 0x1234, name: 'Test Company 1' },
        { id: 0x5678, name: 'Test Company 2' },
        { id: 0x9abc, name: 'Test Company 3' },
        { id: 12345, name: 'Test Company 4' },
      ]);
    });
  });
});
