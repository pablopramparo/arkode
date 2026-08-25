export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  details?: string;
}

export interface DumpValidator {
  readonly engine: 'postgres' | 'mysql' | 'mariadb' | 'generic';
  validate(localFilePath: string): Promise<ValidationResult>;
}
