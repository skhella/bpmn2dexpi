/**
 * The Neo4j exporter reads the DEXPI 2.0.1 material-state shape — state
 * types composed under MaterialState.State and the Composition under
 * MaterialStateType.Composition, MoleFractions / RatioUnit — and produces
 * the same graph as for the 2.0.0 export of the same model.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

import { BpmnToDexpiTransformer } from '../../transformer/BpmnToDexpiTransformer';
import { parseDexpiXml, generateCypherQueries } from '../neo4jExporter';
import type { DexpiGraphData } from '../neo4jExporter';

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');

function relCount(queries: string[], rel: string): number {
  return queries.filter(q => new RegExp(`\\[:${rel}\\b`).test(q)).length;
}

describe('neo4jExporter — DEXPI 2.0.1 shape', () => {
  let d200: DexpiGraphData;
  let d201: DexpiGraphData;
  let q200: string[];
  let q201: string[];

  beforeAll(async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const x200 = await new BpmnToDexpiTransformer().transform(bpmn, { dexpiVersion: '2.0.0' });
    const x201 = await new BpmnToDexpiTransformer().transform(bpmn, { dexpiVersion: '2.0.1' });
    expect(x201).not.toContain('property="MaterialStateTypes"');
    d200 = parseDexpiXml(x200);
    d201 = parseDexpiXml(x201);
    q200 = generateCypherQueries(d200, { clearDatabase: false });
    q201 = generateCypherQueries(d201, { clearDatabase: false });
  }, 60_000);

  it('finds every nested MaterialStateType and its MaterialState link', () => {
    expect(d201.materialStateTypes.length).toBe(12);
    expect(d201.materialStateTypes.length).toBe(d200.materialStateTypes.length);
    expect(d201.materialStates.length).toBe(12);
    for (const s of d201.materialStates) {
      expect(s.typeRef, s.id).toBeDefined();
      expect(d201.materialStateTypes.some(t => t.id === s.typeRef), s.id).toBe(true);
    }
  });

  it('pairs the MoleFractions vector with the template components and copies the Composition scalars', () => {
    const fractions = (d: DexpiGraphData) => d.materialStateTypes.reduce((n, t) => n + t.fractions.length, 0);
    expect(fractions(d201)).toBe(fractions(d200));
    expect(fractions(d201)).toBeGreaterThan(0);
    expect(d201.materialStateTypes.every(t => t.fractions.every(f => f.basis === 'Mole'))).toBe(true);
    const withMoleFlow = d201.materialStateTypes.filter(t => t.attributes.MoleFlow_value !== undefined);
    expect(withMoleFlow.length).toBe(12);
    expect(withMoleFlow[0].attributes.MoleFlow_unit).toBe('KilomolePerSecond');
  });

  it('produces the same node and relationship counts as the 2.0.0 export', () => {
    const nodes = (qs: string[]) => qs.filter(q => /^CREATE \(:/.test(q)).length;
    expect(nodes(q201)).toBe(nodes(q200));
    expect(q201.length).toBe(q200.length);
    for (const rel of ['HAS_FRACTION', 'USES_TEMPLATE', 'OBSERVES', 'MEASURES', 'CONTAINS']) {
      expect(relCount(q201, rel), rel).toBe(relCount(q200, rel));
    }
    expect(relCount(q201, 'HAS_FRACTION')).toBeGreaterThan(0);
  });
});
