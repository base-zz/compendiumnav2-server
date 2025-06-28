import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ManufacturerConfig } from '../types/Manufacturer';

export class ConfigLoader {
  private static instance: ConfigLoader;
  private config: ManufacturerConfig = { company_identifiers: [] };
  private companyMap: Map<number, string> = new Map();

  private constructor() {
    this.loadConfig();
  }

  public static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  private getConfigPath(): string {
    // Look for config in the following locations:
    // 1. Environment variable
    // 2. Local config directory
    // 3. Default location
    return (
      process.env.BTMAN_CONFIG ||
      path.join(__dirname, 'btman.yml')
    );
  }

  private loadConfig(): void {
    try {
      const configPath = this.getConfigPath();
      if (!fs.existsSync(configPath)) {
        console.warn(`⚠️ Config file not found at ${configPath}`);
        return;
      }

      const fileContents = fs.readFileSync(configPath, 'utf8');
      this.config = yaml.load(fileContents) as ManufacturerConfig;
      this.buildCompanyMap();
      
      console.log(`✅ Loaded ${this.config.company_identifiers.length} manufacturer entries`);
    } catch (error) {
      console.error('❌ Failed to load config:', error);
      throw error;
    }
  }

  private buildCompanyMap(): void {
    if (!this.config?.company_identifiers) return;

    this.config.company_identifiers.forEach(entry => {
      try {
        let id: number;
        
        if (typeof entry.value === 'string') {
          // Handle hex strings (e.g., '0x0499')
          if (entry.value.startsWith('0x')) {
            id = parseInt(entry.value.substring(2), 16);
          } else {
            id = parseInt(entry.value, 10);
          }
        } else {
          id = entry.value;
        }

        if (!isNaN(id)) {
          this.companyMap.set(id, entry.name);
        } else {
          console.warn(`⚠️ Invalid company ID: ${entry.value}`);
        }
      } catch (error) {
        console.warn(`⚠️ Error processing company ID ${entry.value}:`, error);
      }
    });
  }

  public getCompanyName(id: number): string | undefined {
    return this.companyMap.get(id);
  }

  public getCompanyId(name: string): number | undefined {
    for (const [id, companyName] of this.companyMap.entries()) {
      if (companyName === name) return id;
    }
    return undefined;
  }

  public getAllCompanies(): { id: number; name: string }[] {
    return Array.from(this.companyMap.entries()).map(([id, name]) => ({
      id,
      name,
    }));
  }

  public reload(): void {
    this.companyMap.clear();
    this.loadConfig();
  }
}

// Export a singleton instance
export const configLoader = ConfigLoader.getInstance();
