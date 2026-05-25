/**
 * Shared Neo4j HTTP-API helpers: Bolt-style URI translation and
 * basic-auth header encoding for the REST tx-commit endpoint.
 */

import type { Neo4jConfig } from './neo4jExporter';

/**
 * Translate a Bolt-style Neo4j URI to the HTTP API endpoint URL the
 * REST tx-commit handler is served from.
 *
 * Conversion rules (matching what the official Neo4j drivers do):
 *   - bolt://      → http://    (port 7687 → 7474 when present)
 *   - bolt+s://    → https://   (port 7687 → 7473 when present)
 *   - neo4j://     → http://    (port 7687 → 7474 when present)
 *   - neo4j+s://   → https://   (port 7687 → 7473 when present)
 *
 * Aura URIs typically omit the port (relying on the scheme's default
 * — 443 for https), so the `:7687`→`:7473` substitution is conditional
 * on the port being present. Without an explicit port the URL just
 * loses the bolt scheme prefix and inherits the HTTPS default.
 *
 * The +s ordering matters: `bolt+s://` must be checked before
 * `bolt://` because `'bolt+s://x'.startsWith('bolt://')` is false (the
 * scheme differs) — left here in dependency order for clarity.
 */
export function boltToHttpEndpoint(uri: string, database: string): string {
  let httpUri = uri;
  if (uri.startsWith('bolt+s://')) {
    httpUri = uri.replace('bolt+s://', 'https://').replace(':7687', ':7473');
  } else if (uri.startsWith('neo4j+s://')) {
    httpUri = uri.replace('neo4j+s://', 'https://').replace(':7687', ':7473');
  } else if (uri.startsWith('bolt://')) {
    httpUri = uri.replace('bolt://', 'http://').replace(':7687', ':7474');
  } else if (uri.startsWith('neo4j://')) {
    httpUri = uri.replace('neo4j://', 'http://').replace(':7687', ':7474');
  }
  return `${httpUri}/db/${database}/tx/commit`;
}

/**
 * UTF-8-safe Basic Auth header encoding.
 *
 * The browser's `btoa` only handles Latin-1 — passing a non-ASCII
 * username or password (e.g. German umlauts, Greek letters, anything
 * outside U+00FF) throws `InvalidCharacterError`. We pre-encode the
 * string as UTF-8 bytes (TextEncoder) and feed each byte through
 * String.fromCharCode so any valid credential survives.
 */
export function basicAuthHeader(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let latin1 = '';
  for (const b of bytes) latin1 += String.fromCharCode(b);
  return `Basic ${btoa(latin1)}`;
}

/** Convenience: build endpoint + auth from a Neo4jConfig in one call. */
export function neo4jHttpDetails(config: Neo4jConfig): {
  endpoint: string;
  authHeader: string;
} {
  return {
    endpoint: boltToHttpEndpoint(config.uri, config.database ?? 'neo4j'),
    authHeader: basicAuthHeader(config.user, config.password),
  };
}
