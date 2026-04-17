/**
 * Unit tests for BpmnToDexpiTransformer
 *
 * Covers (per rebuttal commitments):
 *  R1-C1  – automated tests exist
 *  R1-C3  – extensionElements annotation is authoritative; name-inference emits a warning
 *  R1-C4  – duplicate port name+direction emits a warning
 *  R1-C6  – TypeScript compilation validates no `any` types remain (build-time)
 */

import { describe, it, expect } from 'vitest';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';

/** Minimal valid BPMN wrapper around a process body string */
function bpmn(processBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/bpmn-extension/1.0"
             targetNamespace="http://example.com/bpmn">
  <process id="Process_1" isExecutable="false">
    ${processBody}
  </process>
</definitions>`;
}

/** Minimal task with an explicit dexpiType in extensionElements */
function annotatedTask(id: string, name: string, dexpiClass: string, ports = ''): string {
  return `<task id="${id}" name="${name}">
    <extensionElements>
      <dexpi:element dexpiType="${dexpiClass}" identifier="${id}" uid="uid-${id}">
        ${ports}
      </dexpi:element>
    </extensionElements>
  </task>`;
}

/** Task with NO extensionElements — relies on heuristic name matching */
function plainTask(id: string, name: string): string {
  return `<task id="${id}" name="${name}"/>`;
}

function startEvent(id: string, name: string): string {
  return `<startEvent id="${id}" name="${name}">
    <extensionElements>
      <dexpi:element dexpiType="Source" identifier="${id}" uid="uid-${id}"/>
    </extensionElements>
    <outgoing>Flow_out_${id}</outgoing>
  </startEvent>`;
}

function endEvent(id: string, name: string): string {
  return `<endEvent id="${id}" name="${name}">
    <extensionElements>
      <dexpi:element dexpiType="Sink" identifier="${id}" uid="uid-${id}"/>
    </extensionElements>
    <incoming>Flow_in_${id}</incoming>
  </endEvent>`;
}

function seqFlow(id: string, src: string, tgt: string): string {
  return `<sequenceFlow id="${id}" sourceRef="${src}" targetRef="${tgt}"/>`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

describe('BpmnToDexpiTransformer – unit tests', () => {

  // ── R1-C3: extensionElements is authoritative ─────────────────────────────
  describe('R1-C3 – type resolution', () => {
    it('uses dexpiType from extensionElements without emitting a warning', async () => {
      const xml = bpmn(`
        ${annotatedTask('T1', 'ReactingChemicals', 'ReactingChemicals')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'Product')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);

      const t = new BpmnToDexpiTransformer();
      await t.transform(xml);

      expect(t.logger.warnings.length).toBe(0);
    });

    it('emits a warning when falling back to heuristic name inference', async () => {
      const xml = bpmn(`
        ${plainTask('T1', 'ReactingChemicals')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'Product')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);

      const t = new BpmnToDexpiTransformer();
      await t.transform(xml);

      expect(t.logger.warnings.length).toBeGreaterThan(0);
      expect(t.logger.warnings[0]).toMatch(/heuristic/i);
    });

    it('does NOT misclassify "Pump feed data to dashboard" as Pumping when annotated', async () => {
      // With annotation: uses explicit type
      const xml = bpmn(`
        ${annotatedTask('T1', 'Pump feed data to dashboard', 'ProcessStep')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'End')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);
      // No heuristic warning because extensionElements annotation is present
      expect(t.logger.warnings.length).toBe(0);
      // Should not contain Pumping
      expect(out).not.toMatch(/Process\.Pumping/);
    });

    it('warns and falls back for "Pump feed data to dashboard" without annotation', async () => {
      // Without annotation: heuristic fires, would match "Pumping" (substring match)
      // The warning must tell the user this happened
      const xml = bpmn(`
        ${plainTask('T1', 'Pump feed data to dashboard')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'End')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      await t.transform(xml);

      expect(t.logger.warnings.length).toBeGreaterThan(0);
      expect(t.logger.warnings.some(w => w.includes('Pump feed data to dashboard'))).toBe(true);
    });

    it('defaults to ProcessStep and warns when name contains no DEXPI class', async () => {
      const xml = bpmn(`
        ${plainTask('T1', 'Widget Assembly Line 3')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'End')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      await t.transform(xml);
      expect(t.logger.warnings.some(w => /defaulting to.*ProcessStep/i.test(w))).toBe(true);
    });
  });

  // ── R1-C4: duplicate port detection ──────────────────────────────────────
  describe('R1-C4 – duplicate port detection', () => {
    it('emits a warning when two ports share the same name and direction', async () => {
      const ports = `
        <dexpi:port portId="p1" name="MO1" direction="Outlet" portType="MaterialPort"/>
        <dexpi:port portId="p2" name="MO1" direction="Outlet" portType="MaterialPort"/>
      `;
      const xml = bpmn(`
        ${annotatedTask('T1', 'Separating', 'Separating', ports)}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'Product')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      await t.transform(xml);
      expect(t.logger.warnings.some(w => /duplicate port/i.test(w))).toBe(true);
    });

    it('does NOT warn when ports share name but have opposite directions', async () => {
      const ports = `
        <dexpi:port portId="p1" name="MO1" direction="Inlet" portType="MaterialPort"/>
        <dexpi:port portId="p2" name="MO1" direction="Outlet" portType="MaterialPort"/>
      `;
      const xml = bpmn(`
        ${annotatedTask('T1', 'Separating', 'Separating', ports)}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'Product')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      await t.transform(xml);
      expect(t.logger.warnings.some(w => /duplicate port/i.test(w))).toBe(false);
    });
  });

  // ── logger reset between calls ────────────────────────────────────────────
  describe('logger lifecycle', () => {
    it('resets warnings between successive transform() calls', async () => {
      const plainXml = bpmn(`
        ${plainTask('T1', 'UnknownStep')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'End')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const cleanXml = bpmn(`
        ${annotatedTask('T1', 'Pumping', 'Pumping')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'End')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);

      const t = new BpmnToDexpiTransformer();
      await t.transform(plainXml);
      expect(t.logger.warnings.length).toBeGreaterThan(0);

      await t.transform(cleanXml);
      expect(t.logger.warnings.length).toBe(0);
    });
  });

  // ── basic output structure ────────────────────────────────────────────────
  describe('output structure', () => {
    it('generates XML containing the expected DEXPI ProcessStep', async () => {
      const xml = bpmn(`
        ${annotatedTask('T1', 'ReactingChemicals', 'ReactingChemicals')}
        ${startEvent('SE1', 'FeedA')}
        ${endEvent('EE1', 'Product')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);

      expect(out).toContain('ReactingChemicals');
      expect(out).toContain('uid_T1');  // sanitizeId converts hyphens → underscores per XSD pattern
    });

    it('generates valid XML (no unclosed tags)', async () => {
      const xml = bpmn(`
        ${annotatedTask('T1', 'Pumping', 'Pumping')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'Product')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);

      // Use the globally-available DOMParser (provided by vitest's jsdom environment)
      const parsed = new DOMParser().parseFromString(out, 'text/xml');
      const err = parsed.querySelector('parsererror');
      expect(err).toBeNull();
    });

    it('returns empty process steps for empty BPMN', async () => {
      const xml = bpmn('');
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });
  });

  // ── inferDexpiTypeFromName edge cases ─────────────────────────────────────
  describe('inferDexpiTypeFromName (accessed via plain tasks)', () => {
    const cases: [string, string | null][] = [
      ['ReactingChemicals', 'ReactingChemicals'],  // exact match
      ['reacting chemicals', null],                  // no match → ProcessStep (warns)
      ['Compressing', 'Compressing'],               // exact match
      ['StrippingDistilling', 'StrippingDistilling'], // exact match
    ];

    cases.forEach(([taskName, expectedClass]) => {
      it(`task name "${taskName}" → ${expectedClass ?? 'ProcessStep (with warning)'}`, async () => {
        const xml = bpmn(`
          ${plainTask('T1', taskName)}
          ${startEvent('SE1', 'Feed')}
          ${endEvent('EE1', 'End')}
          ${seqFlow('F1', 'SE1', 'T1')}
          ${seqFlow('F2', 'T1', 'EE1')}
        `);
        const t = new BpmnToDexpiTransformer();
        const out = await t.transform(xml);

        if (expectedClass) {
          // Should be in output AND a warning should still fire (heuristic path)
          expect(out).toContain(expectedClass);
          expect(t.logger.warnings.length).toBeGreaterThan(0);
        } else {
          // Falls to ProcessStep
          expect(out).toContain('ProcessStep');
        }
      });
    });
  });
});
