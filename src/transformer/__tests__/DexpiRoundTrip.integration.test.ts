/**
 * Data-completeness round-trip: BPMN → DEXPI₁ → BPMN₂ → DEXPI₂.
 *
 * The acceptance criterion for the DEXPI-import feature: the SECOND export
 * carries the same information-model content as the first. Comparison is a
 * multiset of per-object content signatures — type, Data values (including
 * enum DataReference targets and values aggregated in AggregatedDataValue
 * carriers), References target counts, and Components child types — which
 * is insensitive to sibling order and to per-run artifacts (generated
 * connector/model ids, the ExportDateTime stamp) but catches any lost or
 * altered property value, quantity, unit, fraction, reference, or object.
 *
 * On the Tennessee Eastman benchmark this pins, among everything else:
 * stream quantities with Provenance/Range qualifiers, MaterialStateType
 * scalars (MoleFlow with KilomolePerSecond units), composition fraction
 * vectors (MoleFractiona + Percent), the full material library
 * (templates / components incl. QualifiedValue payloads / states / state
 * types / compositions), port hierarchies (SubReference), Method literals,
 * and instrumentation measured-variable payloads.
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
import { DexpiToBpmnTransformer } from '../DexpiToBpmnTransformer';

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');
const SCHEMA_DIR = join(__dirname, '../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');

/** Per-object local content signature (order-free, id-free). */
function localSig(el: Element): string {
  const type = el.getAttribute('type') ?? '';
  const parts: string[] = [];
  for (const c of Array.from(el.children)) {
    if (c.tagName === 'Data') {
      const prop = c.getAttribute('property');
      if (prop === 'ExportDateTime') continue; // per-run stamp
      const vals = Array.from(c.children).map(v =>
        v.tagName === 'DataReference'
          ? `ref:${v.getAttribute('data') ?? ''}`
          : v.tagName === 'AggregatedDataValue'
            ? `agg[${localSig(v as Element)}]`
            : `${v.tagName}:${(v.textContent ?? '').trim()}`).sort().join(',');
      parts.push(`D[${prop}=${vals}]`);
    } else if (c.tagName === 'References') {
      const n = (c.getAttribute('objects') ?? '').trim().split(/\s+/).filter(Boolean).length;
      parts.push(`R[${c.getAttribute('property')}#${n}]`);
    } else if (c.tagName === 'Components') {
      const kidTypes = Array.from(c.children)
        .map(k => (k as Element).getAttribute('type') ?? (k as Element).tagName)
        .sort().join(',');
      parts.push(`C[${c.getAttribute('property')}:${kidTypes}]`);
    }
  }
  return `${type}{${parts.sort().join(';')}}`;
}

function signatureMultiset(xml: string): Map<string, number> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const m = new Map<string, number>();
  for (const obj of Array.from(doc.getElementsByTagName('Object'))) {
    const s = localSig(obj);
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

describe('DEXPI import round-trip — data completeness', () => {
  it('second export carries identical content to the first (TEP benchmark)', { timeout: 120_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const options = { processXml: PROCESS_XML, coreXml: CORE_XML };

    const d1 = await new BpmnToDexpiTransformer().transform(bpmn, options);
    const b2 = await new DexpiToBpmnTransformer().transform(d1, options);
    const d2 = await new BpmnToDexpiTransformer().transform(b2, options);

    const s1 = signatureMultiset(d1);
    const s2 = signatureMultiset(d2);
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

    // Same object count and, object-for-object, identical content.
    expect(total(s2)).toBe(total(s1));
    const missing: string[] = [];
    for (const [sig, n1] of s1) {
      const n2 = s2.get(sig) ?? 0;
      if (n2 !== n1) missing.push(`×${n1}→×${n2}  ${sig.slice(0, 200)}`);
    }
    expect(missing, `content lost or altered in second export:\n${missing.join('\n')}`).toEqual([]);

    // Spot anchors on the second export — belt and braces over the generic
    // multiset (each of these previously fell out of the round-trip).
    expect(d2).toContain('MoleFlowRateUnit.KilomolePerSecond');
    expect(d2).toContain('property="MoleFractiona"');
    expect(d2).toContain('PercentageUnit.Percent');
    expect(d2).toContain('QuantityProvenance.Specified');
    expect((d2.match(/property="SubReference"/g) ?? []).length)
      .toBe((d1.match(/property="SubReference"/g) ?? []).length);
    expect((d2.match(/Process\.MaterialTemplate"/g) ?? []).length)
      .toBe((d1.match(/Process\.MaterialTemplate"/g) ?? []).length);
    expect((d2.match(/Process\.Composition"/g) ?? []).length)
      .toBe((d1.match(/Process\.Composition"/g) ?? []).length);
  });
});
