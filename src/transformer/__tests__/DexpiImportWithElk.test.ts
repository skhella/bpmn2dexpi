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

  it('imports subprocesses COLLAPSED with their own drill-in plane', { timeout: 15_000 }, async () => {
    // A DEXPI model whose middle step is a SubProcessStep (→ bpmn:subProcess).
    const dexpiXml = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="m" uri="http://www.example.org">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="pm1" type="Process/ProcessModel">
        <Components property="ProcessSteps">
          <Object id="FEED" type="Process/Process.Source">
            <Data property="Identifier"><String>FEED</String></Data>
            <Data property="Label"><String>Feed</String></Data>
          </Object>
          <Object id="RC1" type="Process/Process.ReactingChemicals">
            <Data property="Identifier"><String>RC1</String></Data>
            <Data property="Label"><String>Reactor section</String></Data>
            <Components property="SubProcessSteps">
              <Object id="MX1" type="Process/Process.Mixing">
                <Data property="Identifier"><String>MX1</String></Data>
                <Data property="Label"><String>Mixer</String></Data>
              </Object>
              <Object id="RX1" type="Process/Process.ReactingChemicals">
                <Data property="Identifier"><String>RX1</String></Data>
                <Data property="Label"><String>Reactor</String></Data>
              </Object>
            </Components>
          </Object>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;

    const elkBpmn = await importDexpiWithElk(dexpiXml);

    // Never force-expanded: the ELK relayout must not mark any subprocess expanded.
    expect(elkBpmn).not.toContain('isExpanded="true"');
    // The subprocess must be collapsed on its parent plane...
    expect(elkBpmn).toContain('isExpanded="false"');
    // ...and reachable via its own drill-in plane (bpmnElement = subprocess id).
    expect(elkBpmn).toMatch(/<bpmndi:BPMNPlane[^>]*bpmnElement="bpmn_RC1"/);
  });
});
