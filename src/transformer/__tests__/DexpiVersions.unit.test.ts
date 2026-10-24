/**
 * dexpiVersions — the small, model-free part of version handling: URIs,
 * bundled paths, and recognising a document's release from its imports.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_DEXPI_VERSION, DEXPI_VERSIONS, DEXPI_XSD_FILENAME,
  dexpiModelImportSource, dexpiModelRelativePath, dexpiVersionFromModelUri,
  detectDexpiVersion, isDexpiVersion,
} from '../dexpiVersions';
import { DexpiProcessClassRegistry } from '../DexpiProcessClassRegistry';

const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');

describe('dexpiVersions', () => {
  it('bundles every release it names, at the documented paths', () => {
    expect(DEXPI_VERSIONS).toEqual(['2.0.0', '2.0.1']);
    expect(DEFAULT_DEXPI_VERSION).toBe('2.0.0');
    for (const v of DEXPI_VERSIONS) {
      for (const m of ['Process', 'Core', 'Plant'] as const) {
        expect(existsSync(join(SCHEMA_DIR, dexpiModelRelativePath(v, m))), `${v} ${m}`).toBe(true);
      }
    }
    expect(dexpiModelRelativePath('2.0.0', 'Process')).toBe('Process.xml');
    expect(dexpiModelRelativePath('2.0.1', 'Process')).toBe('2.0.1/Process.xml');
    expect(existsSync(join(SCHEMA_DIR, DEXPI_XSD_FILENAME))).toBe(true);
  });

  it('builds and parses published model URIs', () => {
    expect(dexpiModelImportSource('2.0.1', 'Core')).toBe('https://data.dexpi.org/models/2.0.1/Core.xml');
    expect(dexpiVersionFromModelUri('https://data.dexpi.org/models/2.0.0/Process.xml')).toBe('2.0.0');
    expect(dexpiVersionFromModelUri('https://data.dexpi.org/models/3.0.0/Process.xml')).toBeNull();
    expect(dexpiVersionFromModelUri('tep.profile.xml')).toBeNull();
    expect(isDexpiVersion('2.0.1')).toBe(true);
    expect(isDexpiVersion('2.0')).toBe(false);
    expect(isDexpiVersion(undefined)).toBe(false);
  });

  it('recognises a document\'s release from its imports (Process decides; profiles are ignored)', () => {
    const doc = (core: string, process: string) =>
      `<Model name="m" uri="urn:m"><Import prefix="Core" source="${core}"/>` +
      `<Import prefix="Process" source="${process}"/><Import prefix="Profile" source="tep.profile.xml"/></Model>`;
    expect(detectDexpiVersion(doc('https://data.dexpi.org/models/2.0.1/Core.xml', 'https://data.dexpi.org/models/2.0.1/Process.xml')))
      .toEqual({ version: '2.0.1', declared: '2.0.1' });
    expect(detectDexpiVersion(doc('https://data.dexpi.org/models/2.0.0/Core.xml', 'https://data.dexpi.org/models/2.0.0/Process.xml')))
      .toEqual({ version: '2.0.0', declared: '2.0.0' });
    // Mixed imports: the Process model's release wins.
    expect(detectDexpiVersion(doc('https://data.dexpi.org/models/2.0.0/Core.xml', 'https://data.dexpi.org/models/2.0.1/Process.xml')).version)
      .toBe('2.0.1');
    expect(detectDexpiVersion(doc('https://data.dexpi.org/models/2.5.0/Core.xml', 'https://data.dexpi.org/models/2.5.0/Process.xml')))
      .toEqual({ version: null, declared: '2.5.0' });
    expect(detectDexpiVersion('<Model name="m" uri="urn:m"><Import prefix="P" source="local/Process.xml"/></Model>'))
      .toEqual({ version: null, declared: null });
    expect(detectDexpiVersion('<Model name="m" uri="urn:m"/>')).toEqual({ version: null, declared: null });
    // Namespace-prefixed serialisations are read too.
    expect(detectDexpiVersion('<d:Model xmlns:d="x"><d:Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/></d:Model>').version)
      .toBe('2.0.1');
  });

  it('loadDefault() reads the release asked for, and the default otherwise', async () => {
    const r201 = await DexpiProcessClassRegistry.loadDefault({ version: '2.0.1' });
    expect(r201.dexpiVersion).toBe('2.0.1');
    expect(r201.compositionFractionProperty('Mole')).toBe('MoleFractions');
    const r200 = await DexpiProcessClassRegistry.loadDefault();
    expect(r200.dexpiVersion).toBe('2.0.0');
    expect(r200.compositionFractionProperty('Mole')).toBe('MoleFractiona');
    const sources = await DexpiProcessClassRegistry.loadBundledModelSources('2.0.1', ['Process', 'Plant', 'Core']);
    expect(sources.map(s => s.name)).toEqual(['Process.xml', 'Plant.xml', 'Core.xml']);
    expect(sources[0].xml).toContain('uri="https://data.dexpi.org/models/2.0.1/Process.xml"');
  });

  it('a registry built from inline fixtures has no release and keeps the published fallbacks', () => {
    const reg = DexpiProcessClassRegistry.fromXml('<Model name="Process" uri="https://test"></Model>');
    expect(reg.dexpiVersion).toBeNull();
    expect(reg.modelUri('Process')).toBe('https://test');
    expect(reg.modelUri('Core')).toBeUndefined();
    expect(DexpiProcessClassRegistry.empty().dexpiVersion).toBeNull();
  });
});
