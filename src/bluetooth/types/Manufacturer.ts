export interface Manufacturer {
  value: number | string;
  name: string;
  code?: string;
  country?: string;
  comment?: string;
  parent?: string;
}

export interface ManufacturerConfig {
  company_identifiers: Manufacturer[];
}
