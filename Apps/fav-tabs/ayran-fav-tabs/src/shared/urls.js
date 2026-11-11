// Url helpers: display form, "equal" normalization, second level domain and match levels.

/** Url without the protocol, so it starts with the domain ("https://a.com/x" -> "a.com/x"). */
export function displayUrl(url) {
  if (!url) return '';
  return url.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, '');
}

/**
 * Normalized form used for the "Equal" match: ignores redundant forward slashes
 * (repeated ones and trailing ones in the path), and a lone "?" or "#".
 */
export function normalizeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url || '').replace(/\/{2,}/g, '/').replace(/[/?#]+$/, '');
  }
  let path = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  // URL already drops a lone "?" or "#" from .search / .hash; "?&" style noise is kept on purpose.
  const auth = u.username ? `${u.username}${u.password ? ':' + u.password : ''}@` : '';
  const prefix = u.host || u.protocol === 'file:' ? `${u.protocol}//${auth}${u.host}` : u.protocol;
  return `${prefix}${path}${u.search}${u.hash}`;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function protocolOf(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

// Second level labels that ccTLDs commonly put registrations under (example.co.uk).
// Not a full public suffix list, but it keeps "co.uk" from grouping every UK site together.
const CC_SECOND_LEVELS = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'gob', 'mil', 'nom', 'ltd', 'plc', 'sch', 'ne', 'or', 'go', 'gv', 'info', 'biz',
]);

/** The "second level domain" of a host: "mail.google.com" -> "google.com", "a.b.co.uk" -> "b.co.uk". */
export function secondLevelDomain(host) {
  host = (host || '').toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && CC_SECOND_LEVELS.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Key that groups urls by second level domain (urls without a host group by protocol). */
export function sldKey(url) {
  const host = hostOf(url);
  return `${protocolOf(url)}//${secondLevelDomain(host)}`;
}

export const MATCH_LEVELS = ['exact', 'equal', 'domain', 'sld'];

/** How closely `other` matches `url`: 'exact' | 'equal' | 'domain' | 'sld' | null (no match). */
export function matchLevel(url, other) {
  if (!url || !other) return null;
  if (url === other) return 'exact';
  if (normalizeUrl(url) === normalizeUrl(other)) return 'equal';
  const h1 = hostOf(url);
  const h2 = hostOf(other);
  if (h1 || h2) {
    if (h1 === h2) return 'domain';
    if (secondLevelDomain(h1) === secondLevelDomain(h2)) return 'sld';
    return null;
  }
  // Hostless urls (e.g. file:, about:) only group with the same protocol.
  return protocolOf(url) && protocolOf(url) === protocolOf(other) ? 'sld' : null;
}
