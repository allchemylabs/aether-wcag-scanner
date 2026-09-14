/**
 * Firecrawl Integration Module
 *
 * This module integrates with Firecrawl API to discover all pages on a website.
 *
 * Setup:
 * 1. Get a Firecrawl API key from https://www.firecrawl.dev
 * 2. Add to .env file: FIRECRAWL_API_KEY="your-api-key"
 * 3. The module uses Firecrawl v2 MAP API endpoint
 *
 * The MAP API returns a structured map of all crawlable URLs on a domain,
 * which is more efficient than traditional sitemap crawling.
 */

export interface CrawlMapResult {
  urls: string[];
  totalPages: number;
  degraded?: boolean;
  degradedReason?: string;
}

export async function getCrawlMap(domain: string): Promise<CrawlMapResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    const reason = 'FIRECRAWL_API_KEY not set — multi-page discovery unavailable. ' +
      'Set FIRECRAWL_API_KEY in .env to enable. Get a key at https://www.firecrawl.dev';
    console.warn(reason);

    return {
      urls: [domain],
      totalPages: 1,
      degraded: true,
      degradedReason: reason,
    };
  }

  try {
    const result = await callFirecrawlMapAPI(domain, apiKey);
    return result;
  } catch (err) {
    const reason = `Firecrawl API failed: ${(err as Error).message} — falling back to single URL`;
    console.warn(reason);

    return {
      urls: [domain],
      totalPages: 1,
      degraded: true,
      degradedReason: reason,
    };
  }
}

/**
 * Call Firecrawl v2 MAP API using REST endpoint
 */
async function callFirecrawlMapAPI(domain: string, apiKey: string): Promise<CrawlMapResult> {
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/map', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: domain,
        limit: 5000,
        includeSubdomains: false,
        sitemap: 'include',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Firecrawl API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as any;

    // Debug: Log raw response structure
    if (process.env.DEBUG_FIRECRAWL === 'true') {
      console.error('DEBUG: Raw Firecrawl response:', JSON.stringify(data, null, 2).substring(0, 500));
    }

    // Firecrawl v2 returns links as array of objects with .url property
    let urls: string[] = [];
    if (data.links && Array.isArray(data.links)) {
      urls = data.links
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any) => item.url)
        .filter((url: any) => typeof url === 'string');
    }

    if (urls.length === 0) {
      const reason = 'Firecrawl returned no URLs for this domain — falling back to single URL';
      console.warn(reason);
      return {
        urls: [domain],
        totalPages: 1,
        degraded: true,
        degradedReason: reason,
      };
    }

    return {
      urls: urls.filter((url: any) => typeof url === 'string'),
      totalPages: urls.length,
    };
  } catch (err) {
    throw new Error(
      `Failed to call Firecrawl MAP API: ${(err as Error).message}`
    );
  }
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

/**
 * Filter URLs to only include pages from the same domain
 * Handles cases where base domain may or may not have www prefix
 */
export function filterDomainUrls(urls: string[], baseDomain: string): string[] {
  try {
    const baseParsed = new URL(baseDomain);
    const baseHostname = baseParsed.hostname || '';
    // Normalize hostname: remove www prefix for comparison
    const baseNormalized = baseHostname.replace(/^www\./, '');

    return urls.filter(url => {
      try {
        const urlParsed = new URL(url);
        const urlHostname = urlParsed.hostname || '';
        const urlNormalized = urlHostname.replace(/^www\./, '');

        // Match if normalized hostnames are the same
        return urlNormalized === baseNormalized;
      } catch {
        return false;
      }
    });
  } catch {
    throw new Error(`Invalid base domain: ${baseDomain}`);
  }
}

/**
 * Deduplicate URLs
 */
export function deduplicateUrls(urls: string[]): string[] {
  return [...new Set(urls)];
}
