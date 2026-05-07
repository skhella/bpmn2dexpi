/**
 * DexpiImportWithElk — pipeline tests.
 *
 * Verifies the glue between DexpiToBpmnTransformer and ElkBpmnLayout:
 * a DEXPI XML round-trips to BPMN with ELK layout applied, and the
 * skipElk flag preserves the importer's heuristic layout.
 */

import { describe, it, expect } from 'vitest';
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

import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { importDexpiWithElk } from '../DexpiImportWithElk';

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');

describe('importDexpiWithElk — pipeline (DEXPI → importer → ELK relayout)', () => {
  it('round-trips TEP and preserves logical content', { timeout: 15_000 }, async () => {
    // 1. Forward: BPMN → DEXPI.
    const sourceBpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const exporter = new BpmnToDexpiTransformer();
    const dexpiXml = await exporter.transform(sourceBpmn);
    expect(dexpiXml.length).toBeGreaterThan(1000);

    // 2. Reverse: DEXPI → BPMN with ELK layout.
    const elkBpmn = await importDexpiWithElk(dexpiXml);
    expect(elkBpmn.length).toBeGreaterThan(1000);

    // 3. Sanity: result must be parseable.
    const doc = new dom.window.DOMParser().parseFromString(elkBpmn, 'text/xml');
    expect(doc.querySelector('parsererror')).toBeNull();

    // 4. Logical content sanity: at least the same kind of DEXPI elements
    //    survived the round-trip (Source / Sink / ProcessStep types appear).
    expect(elkBpmn).toContain('dexpiType');
    expect(elkBpmn).toMatch(/dexpiType="(Source|Sink|ReactingChemicals|Compressing|MeasuringProcessVariable)"/);

    // 5. Layout sanity: BPMNDiagram exists with shapes (ELK ran).
    const shapeCount = (elkBpmn.match(/<bpmndi:BPMNShape/g) ?? []).length;
    expect(shapeCount).toBeGreaterThan(20);
    const edgeCount = (elkBpmn.match(/<bpmndi:BPMNEdge/g) ?? []).length;
    expect(edgeCount).toBeGreaterThan(10);
  });

  it('skipElk preserves the importer\'s own layout', { timeout: 15_000 }, async () => {
    const sourceBpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const exporter = new BpmnToDexpiTransformer();
    const dexpiXml = await exporter.transform(sourceBpmn);

    const elkBpmn = await importDexpiWithElk(dexpiXml);
    const nativeBpmn = await importDexpiWithElk(dexpiXml, { skipElk: true });

    // Both must be parseable.
    expect(new dom.window.DOMParser().parseFromString(elkBpmn, 'text/xml').querySelector('parsererror')).toBeNull();
    expect(new dom.window.DOMParser().parseFromString(nativeBpmn, 'text/xml').querySelector('parsererror')).toBeNull();

    // Logical content (extracting just the dexpiType="X" set) must be identical.
    const extractDexpiTypes = (xml: string) => {
      const types: string[] = [];
      const re = /dexpiType="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) types.push(m[1]);
      return types.sort();
    };
    expect(extractDexpiTypes(elkBpmn)).toEqual(extractDexpiTypes(nativeBpmn));

    // Layouts must DIFFER (otherwise ELK isn't actually doing anything).
    // We compare a few representative shape coordinates.
    const firstShapeBounds = (xml: string) => {
      const m = xml.match(/<bpmndi:BPMNShape[^>]*>\s*<[^>]*Bounds[^>]*x="([^"]+)"[^>]*y="([^"]+)"/);
      return m ? `${m[1]},${m[2]}` : null;
    };
    expect(firstShapeBounds(elkBpmn)).not.toEqual(firstShapeBounds(nativeBpmn));
  });
});
