/**
 * URL Filter Module
 * Filters and normalizes URLs for scanning
 */

/**
 * Patterns to exclude from scanning
 */
const EXCLUDE_PATTERNS = [
  // Admin and authentication
  /\/admin\//i,
  /\/dashboard\//i,
  /\/login/i,
  /\/logout/i,
  /\/signin/i,
  /\/signup/i,
  /\/auth/i,
  /\/account/i,
  /\/profile/i,

  // API endpoints
  /\/api\//i,
  /\/v\d+\/api/i,

  // File downloads (non-HTML)
  /\.(pdf|zip|exe|dmg|tar|gz|rar)$/i,
  /\/download/i,

  // Media files
  /\.(jpg|jpeg|png|gif|webp|svg|ico|mp4|webm|mp3|wav)$/i,

  // Social media redirects
  /\/share\//i,
  /\/redirect/i,

  // Tracking and analytics
  /\?utm_/i,
  /[?&]fbclid=/i,
  /[?&]gclid=/i,

  // Static assets
  /\.(css|js|map|woff|woff2|ttf|eot)$/i,

  // Version control
  /\.git/i,

  // Temporary/test pages
  /test/i,
  /staging/i,
  /dev/i,
];

/**
 * Filter URLs for scanning
 */
export function filterUrls(urls: string[], baseDomain: string): string[] {
  const filtered = urls
    .map(url => normalizeUrl(url))
    .filter(url => {
      // Exclude by pattern
      for (const pattern of EXCLUDE_PATTERNS) {
        if (pattern.test(url)) {
          return false;
        }
      }
      return true;
    });

  // Remove duplicates while preserving order
  const seen = new Set<string>();
  return filtered.filter(url => {
    if (seen.has(url)) {
      return false;
    }
    seen.add(url);
    return true;
  });
}

/**
 * Normalize URL by removing trailing slash and query params for deduplication
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash for consistency
    let pathname = parsed.pathname;
    if (pathname.endsWith('/') && pathname.length > 1) {
      pathname = pathname.slice(0, -1);
    }
    // Remove common tracking parameters
    const params = new URLSearchParams(parsed.search);
    params.delete('utm_source');
    params.delete('utm_medium');
    params.delete('utm_campaign');
    params.delete('fbclid');
    params.delete('gclid');

    const search = params.toString() ? `?${params.toString()}` : '';
    return `${parsed.protocol}//${parsed.host}${pathname}${search}`;
  } catch {
    return url;
  }
}

/**
 * Limit URLs to a reasonable subset
 */
export function limitUrls(urls: string[], limit: number = 50): string[] {
  // Prioritize important pages
  const prioritized = urls.sort((a, b) => {
    // Prefer shorter paths (likely more important)
    const aDepth = (a.match(/\//g) || []).length;
    const bDepth = (b.match(/\//g) || []).length;
    return aDepth - bDepth;
  });

  return prioritized.slice(0, limit);
}
