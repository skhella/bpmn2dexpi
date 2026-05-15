/**
 * Regression test for the neo4jExporter Composition fraction parsing path
 * (rewritten to walk the canonical Process.xml shape:
 * MaterialStateType.Composition → ListOfMaterialComponents via Stream's
 * MaterialTemplateReference, pairing the Composition's `Values` vector
 * positionally with the template's component uids).
 *
 * Before this path was rewritten the exporter queried for non-existent
 * property names (`TemplateReference`, `Fractions`) and inline-Object
 * structures that the transformer never emits, so zero HAS_FRACTION
 * relationships were ever produced on TEP. This test pins the new
 * end-to-end count so a structural regression in either the transformer
 * emit or the exporter parsing surfaces immediately.
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

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');

describe('neo4jExporter — Composition fraction parsing on TEP', () => {
  let dexpiXml: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;

  beforeAll(async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const t = new BpmnToDexpiTransformer();
    dexpiXml = await t.transform(bpmn);
    data = parseDexpiXml(dexpiXml);
  });

  it('resolves MaterialTemplate.ListOfComponents via separate ListOfMaterialComponents Object', () => {
    // TEP has 2 templates: Water (1 component) + TEP material (8 components).
    expect(data.materialTemplates.length).toBe(2);
    const templateByLabel = Object.fromEntries(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data.materialTemplates.map((t: any) => [t.label, t])
    );
    expect(templateByLabel.Water?.components.length).toBe(1);
    expect(templateByLabel['Tennessee Eastman Material']?.components.length).toBe(8);
  });

  it('parses MaterialTemplateReference + MaterialStateReference on every material stream', () => {
    // TEP authors both references on all 11 material streams.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withState    = data.streams.filter((s: any) => s.materialStateRef).length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withTemplate = data.streams.filter((s: any) => s.materialTemplateRef).length;
    expect(withState).toBe(11);
    expect(withTemplate).toBe(11);
  });

  it('walks Composition → template positional pairing and produces HAS_FRACTION per (state, component)', () => {
    // 10 of the 11 MaterialStateTypes in TEP are reachable via a stream
    // that supplies a template (one MaterialStateType — the "S8 mixed"
    // case in the fixture — is genuinely orphan; no stream carries the
    // state that references it, so its fractions cannot be identity-
    // resolved against any template's ListOfComponents). 10 × 8 = 80.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalFractions = data.materialStateTypes.reduce((s: number, st: any) => s + st.fractions.length, 0);
    expect(totalFractions).toBe(80);

    // Every emitted fraction has a real componentRef, a numeric-looking
    // value string, and a basis ∈ {Mole, Mass}.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const st of data.materialStateTypes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of st.fractions) {
        expect(f.componentRef).toBeTruthy();
        expect(f.value).toBeTruthy();
        expect(['Mole', 'Mass']).toContain(f.basis);
      }
    }

    // Cypher emit count matches the parsed fraction count.
    const queries = generateCypherQueries(data);
    const fractionQueries = queries.filter(q => q.includes('HAS_FRACTION'));
    expect(fractionQueries.length).toBe(80);
  });
});
