import { describe, expect, it } from 'vitest';
import {
  basicAuthHeader,
  boltToHttpEndpoint,
  neo4jHttpDetails,
} from '../neo4jHttpShared';

describe('boltToHttpEndpoint — URL translation parity for both Neo4j HTTP clients', () => {
  it('bolt://host:7687 → http://host:7474', () => {
    expect(boltToHttpEndpoint('bolt://localhost:7687', 'neo4j')).toBe(
      'http://localhost:7474/db/neo4j/tx/commit',
    );
  });

  it('neo4j://host:7687 → http://host:7474', () => {
    expect(boltToHttpEndpoint('neo4j://localhost:7687', 'neo4j')).toBe(
      'http://localhost:7474/db/neo4j/tx/commit',
    );
  });

  it('bolt+s://host:7687 → https://host:7473', () => {
    expect(boltToHttpEndpoint('bolt+s://self-hosted.example.com:7687', 'neo4j')).toBe(
      'https://self-hosted.example.com:7473/db/neo4j/tx/commit',
    );
  });

  it('neo4j+s://host:7687 → https://host:7473', () => {
    expect(boltToHttpEndpoint('neo4j+s://self-hosted.example.com:7687', 'neo4j')).toBe(
      'https://self-hosted.example.com:7473/db/neo4j/tx/commit',
    );
  });

  it('Aura (no explicit port) — neo4j+s:// → https:// at default port 443', () => {
    expect(boltToHttpEndpoint('neo4j+s://aura.databases.neo4j.io', 'neo4j')).toBe(
      'https://aura.databases.neo4j.io/db/neo4j/tx/commit',
    );
  });

  it('respects a non-default database name', () => {
    expect(boltToHttpEndpoint('bolt://localhost:7687', 'mydb')).toContain('/db/mydb/');
  });

  it('+s schemes are checked before plain bolt://; bolt+s://x does NOT route as http://', () => {
    const out = boltToHttpEndpoint('bolt+s://x.example.com:7687', 'neo4j');
    expect(out).toMatch(/^https:/);
    expect(out).not.toMatch(/^http:\/\//);
  });
});

describe('basicAuthHeader — UTF-8-safe Basic Auth', () => {
  it('produces the standard Latin-1 path for ASCII credentials', () => {
    // btoa('neo4j:pw') === 'bmVvNGo6cHc='
    expect(basicAuthHeader('neo4j', 'pw')).toBe('Basic bmVvNGo6cHc=');
  });

  it('does NOT throw on non-ASCII passwords (the classic btoa pitfall)', () => {
    // German umlauts — would throw InvalidCharacterError with naive btoa.
    expect(() => basicAuthHeader('neo4j', 'pässwört')).not.toThrow();
  });

  it('does NOT throw on non-ASCII usernames', () => {
    expect(() => basicAuthHeader('αlpha', 'beta')).not.toThrow();
  });

  it('round-trips a UTF-8 password through base64', () => {
    const header = basicAuthHeader('user', 'pässwört');
    expect(header.startsWith('Basic ')).toBe(true);
    const b64 = header.slice('Basic '.length);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe('user:pässwört');
  });
});

describe('neo4jHttpDetails — convenience over a Neo4jConfig', () => {
  it('combines endpoint + auth from one config object', () => {
    const details = neo4jHttpDetails({
      uri: 'bolt://localhost:7687',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
    expect(details.endpoint).toBe('http://localhost:7474/db/neo4j/tx/commit');
    expect(details.authHeader).toBe('Basic bmVvNGo6cHc=');
  });

  it('defaults the database to "neo4j" when omitted', () => {
    const details = neo4jHttpDetails({
      uri: 'bolt://localhost:7687',
      user: 'neo4j',
      password: 'pw',
    });
    expect(details.endpoint).toContain('/db/neo4j/');
  });
});
