import { describe, it, expect, beforeAll, afterAll, afterEach, jest, beforeEach } from '@jest/globals';
import { ConfigLoader } from '../loader';

// Mock the modules first
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
}));

jest.mock('js-yaml', () => ({
  load: jest.fn(),
}));

// Import the mocks after they've been set up
import * as fs from 'fs';
import * as yaml from 'js-yaml';

// Type assertions for TypeScript
const mockReadFileSync = fs.readFileSync as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockYamlLoad = yaml.load as jest.Mock;

// Sample test configuration
const testConfig = {
  company_identifiers: [
    { name: 'Test Company 1', value: '0x1234' },
    { name: 'Test Company 2', value: '0x5678' },
    { name: 'Test Company 3', value: '0x9abc' },
    { name: 'Test Company 4', value: 12345 },
    { name: 'Invalid Company', value: 'invalid' },
    { name: 'Another Invalid', value: null }
  ]
};

// Mock console
const originalConsole = { ...console };
const mockConsole = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

describe('ConfigLoader', () => {
  let loader: ConfigLoader;
  let originalEnv: NodeJS.ProcessEnv;
  
  beforeAll(() => {
    // Store original process.env
    originalEnv = { ...process.env };
    
    // Set up default mock implementations
    mockReadFileSync.mockReturnValue(JSON.stringify(testConfig));
    mockExistsSync.mockReturnValue(true);
    mockYamlLoad.mockImplementation((content: any) => 
      typeof content === 'string' ? JSON.parse(content) : testConfig
    );
    
    // Mock console
    global.console = mockConsole as unknown as Console;
  });

  afterAll(() => {
    // Restore original console
    global.console = originalConsole;
    // Restore original process.env
    process.env = originalEnv;
    // Clear all mocks
    jest.clearAllMocks();
  });

  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
    
    // Set up default mocks
    mockReadFileSync.mockReturnValue(JSON.stringify(testConfig));
    mockExistsSync.mockReturnValue(true);
    mockYamlLoad.mockReturnValue(testConfig);
    
    // Clear the singleton instance
    (ConfigLoader as any).instance = null;
    
    // Create a new instance for each test
    loader = ConfigLoader.getInstance();
  });

  afterEach(() => {
    // Reset all mocks after each test
    jest.clearAllMocks();
    // Restore original console
    global.console = originalConsole;
  });

  describe('getInstance', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = ConfigLoader.getInstance();
      const instance2 = ConfigLoader.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getConfigPath', () => {
    it('should return the path from environment variable if set', () => {
      const customPath = '/custom/path/config.yml';
      process.env.BTMAN_CONFIG = customPath;
      
      const path = (loader as any).getConfigPath();
      expect(path).toBe(customPath);
    });

    it('should return the default path if environment variable is not set', () => {
      delete process.env.BTMAN_CONFIG;
      
      const path = (loader as any).getConfigPath();
      expect(path).toContain('btman.yml');
    });
  });

  describe('loadConfig', () => {
    it('should load and parse the config file', () => {
      // Force reload the config
      (loader as any).loadConfig();
      
      expect(mockReadFileSync).toHaveBeenCalled();
      expect(mockYamlLoad).toHaveBeenCalled();
    });

    it('should handle missing config file', () => {
      // Set up mock to simulate missing file
      mockExistsSync.mockReturnValueOnce(false);
      
      // Clear the singleton instance
      (ConfigLoader as any).instance = null;
      
      // Mock the console.warn to verify it's called
      const originalWarn = console.warn;
      const mockWarn = jest.fn();
      console.warn = mockWarn;
      
      // Create a new instance to trigger loadConfig
      const testLoader = ConfigLoader.getInstance();
      
      // Verify the warning was logged
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('Config file not found at')
      );
      
      // Restore console.warn
      console.warn = originalWarn;
    });
  });

  describe('getCompanyName', () => {
    it('should return the correct company name for a given ID', () => {
      // Set up mock data
      const companyMap = new Map([
        [0x1234, 'Test Company 1'],
        [0x5678, 'Test Company 2'],
        [0x9abc, 'Test Company 3'],
        [12345, 'Test Company 4']
      ]);
      
      // Set the private companyMap for testing
      (loader as any).companyMap = companyMap;
      
      expect(loader.getCompanyName(0x1234)).toBe('Test Company 1');
      expect(loader.getCompanyName(0x5678)).toBe('Test Company 2');
      expect(loader.getCompanyName(0x9abc)).toBe('Test Company 3');
      expect(loader.getCompanyName(12345)).toBe('Test Company 4');
      expect(loader.getCompanyName(9999)).toBeUndefined();
    });
  });

  describe('getCompanyId', () => {
    it('should return the correct company ID for a given name', () => {
      // Set up mock data
      const testConfig = {
        company_identifiers: [
          { name: 'Test Company 1', value: '0x1234' },
          { name: 'Test Company 2', value: '0x5678' },
          { name: 'Test Company 3', value: '0x9abc' },
          { name: 'Test Company 4', value: 12345 }
        ]
      };
      
      // Set the private config for testing
      (loader as any).config = testConfig;
      
      expect(loader.getCompanyId('Test Company 1')).toBe(0x1234);
      expect(loader.getCompanyId('Test Company 2')).toBe(0x5678);
      expect(loader.getCompanyId('Test Company 3')).toBe(0x9abc);
      expect(loader.getCompanyId('Test Company 4')).toBe(12345);
      expect(loader.getCompanyId('Nonexistent Company')).toBeUndefined();
    });
  });

  describe('reload', () => {
    it('should clear the company map and reload the configuration', () => {
      // First, verify the map has data
      expect(loader.getCompanyName(0x1234)).toBe('Test Company 1');
      
      // Mock a new config
      const newConfig = {
        company_identifiers: [
          { name: 'New Company', value: '0x9999' }
        ]
      };
      mockYamlLoad.mockReturnValueOnce(newConfig);
      
      // Reload the config
      loader.reload();
      
      // Verify the old data is gone and new data is loaded
      expect(loader.getCompanyName(0x1234)).toBeUndefined();
      expect(loader.getCompanyName(0x9999)).toBe('New Company');
    });
  });

  describe('getAllCompanies', () => {
    it('should return all companies in the config', () => {
      // Set up mock data
      const testConfig = {
        company_identifiers: [
          { name: 'Test Company 1', value: '0x1234' },
          { name: 'Test Company 2', value: '0x5678' },
          { name: 'Test Company 3', value: '0x9abc' },
          { name: 'Test Company 4', value: 12345 }
        ]
      };
      
      // Set the private config for testing
      (loader as any).config = testConfig;
      
      // Call the method
      const companies = loader.getAllCompanies();
      
      // Verify the result
      expect(companies).toContainEqual({ id: 0x1234, name: 'Test Company 1' });
      expect(companies).toContainEqual({ id: 0x5678, name: 'Test Company 2' });
      expect(companies).toContainEqual({ id: 0x9abc, name: 'Test Company 3' });
      expect(companies).toContainEqual({ id: 12345, name: 'Test Company 4' });
      expect(companies).toContainEqual({ id: null, name: 'Another Invalid' });
      expect(companies).toHaveLength(5);
    });
  });
});