export interface BatchScanConfig {
  urls: string[];
  outputDir: string;
  multiPage?: boolean;
  concurrency?: number;
}

export interface BatchScanResult {
  url: string;
  success: boolean;
  scanDate: string;
  jsonFile: string;
  error?: string;
  statistics?: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
}

export interface BatchReport {
  timestamp: string;
  totalUrls: number;
  successful: number;
  failed: number;
  results: BatchScanResult[];
}
