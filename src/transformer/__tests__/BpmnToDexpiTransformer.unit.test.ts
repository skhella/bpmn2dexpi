/**
 * Unit tests for BpmnToDexpiTransformer.
 *
 * Covers:
 *  - extensionElements annotation is authoritative; unannotated tasks default
 *    to ProcessStep with a warning
 *  - duplicate port name+direction emits a warning
 *  - TypeScript compilation validates no `any` types remain (build-time)
 */

import { describe, it, expect } from 'vitest';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';

/** Minimal valid BPMN wrapper around a process body string */
function bpmn(processBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
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

/** Task with NO extensionElements — no dexpiType annotation, defaults to ProcessStep */
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

  // ── extensionElements is authoritative ────────────────────────────────────
  describe('type resolution from extensionElements', () => {
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

    it('emits a warning when task has no dexpiType annotation', async () => {
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
      expect(t.logger.warnings[0]).toMatch(/no dexpiType annotation/i);
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

    it('defaults to ProcessStep for "Pump feed data to dashboard" without annotation', async () => {
      // Without annotation: no name inference — always defaults to ProcessStep
      const xml = bpmn(`
        ${plainTask('T1', 'Pump feed data to dashboard')}
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'End')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);

      // Must warn about missing annotation
      expect(t.logger.warnings.some(w => w.includes('Pump feed data to dashboard'))).toBe(true);
      // Must NOT classify as Pumping — no name inference
      expect(out).not.toMatch(/Process\.Pumping/);
      // Must default to ProcessStep
      expect(out).toMatch(/Process\.ProcessStep/);
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
      expect(t.logger.warnings.some(w => /Exporting as generic ProcessStep/i.test(w))).toBe(true);
    });
  });

  // ── duplicate port detection ─────────────────────────────────────────────
  describe('duplicate port detection', () => {
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

  // ── nested boundary proxy whose superReference does not resolve ───────────
  describe('nested Source/Sink port superReference resolution', () => {
    /** Subprocess whose nested Source carries an EEI1 port; parent ports and the child's superReference vary. */
    function sectionWithNestedSource(parentPorts: string, childSuperRef = ''): string {
      return bpmn(`
        <subProcess id="SP1" name="Compressing">
          <extensionElements>
            <dexpi:element dexpiType="Compressing" identifier="SP1" uid="uid-SP1">
              ${parentPorts}
            </dexpi:element>
          </extensionElements>
          <startEvent id="SE_in" name="EEI1">
            <extensionElements>
              <dexpi:element dexpiType="Source" identifier="SE_in" uid="uid-SE_in">
                <dexpi:port id="SE_in_EEI1_port" name="EEI1" portType="ElectricalEnergyPort" direction="Outlet"${childSuperRef ? ` superReference="${childSuperRef}"` : ''}/>
              </dexpi:element>
            </extensionElements>
            <outgoing>F_in</outgoing>
          </startEvent>
          ${annotatedTask('T1', 'Compressing', 'Compressing',
            '<dexpi:port id="T1_EEI1_port" name="EEI1" portType="ElectricalEnergyPort" direction="Inlet"/>')}
          ${seqFlow('F_in', 'SE_in', 'T1')}
        </subProcess>
      `);
    }
    const GAP = /declares superReference=.*but no port with that id/i;

    it('does NOT warn for a nested Source with no superReference — a plain off-page connector is valid DEXPI', async () => {
      // Source is a ProcessStep allowed under SubProcessSteps and
      // Sub/SuperReference are optional: the section needs no port for it.
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(sectionWithNestedSource(''));
      expect(t.logger.warnings.filter(w => GAP.test(w))).toEqual([]);
      expect(out).toContain('type="Process/Process.Source"');
      expect(out).not.toContain('property="SuperReference"');
    });

    it('warns when the nested Source port declares a superReference that resolves to no port on the parent', async () => {
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(sectionWithNestedSource('', 'SP1_EEI1_port'));
      const gapWarnings = t.logger.warnings.filter(w => GAP.test(w));
      expect(gapWarnings).toHaveLength(1);
      expect(gapWarnings[0]).toContain('"Compressing" (id=SP1)');
      expect(gapWarnings[0]).toContain('port "EEI1" (ElectricalEnergyPort, Outlet)');
      expect(gapWarnings[0]).toContain('superReference="SP1_EEI1_port"');
      expect(gapWarnings[0]).toContain('subReference="SE_in_EEI1_port"');
      expect(out).not.toContain('property="SuperReference"');
    });

    it('does NOT warn when the parent declares the port with a subReference to it', async () => {
      const parentPort =
        '<dexpi:port id="SP1_EEI1_port" name="EEI1" portType="ElectricalEnergyPort" direction="Inlet" subReference="SE_in_EEI1_port"/>';
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(sectionWithNestedSource(parentPort, 'SP1_EEI1_port'));
      expect(t.logger.warnings.filter(w => GAP.test(w))).toEqual([]);
      expect(out).toContain('property="SuperReference" objects="#SP1_EEI1_port"');
      expect(out).toMatch(/property="SubReference"[\s\S]*?object="#SE_in_EEI1_port"/);
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
  describe('step Components carrier normalization', () => {
    it('emits ports and a composition-kind custom attribute side by side', async () => {
      // Regression: a step with ports carries Components as a single
      // object; pushing a custom (composition-kind) attribute used to
      // throw "Components.push is not a function".
      const xml = bpmn(`
        <task id="T1" name="Mixing">
          <extensionElements>
            <dexpi:element dexpiType="Mixing" identifier="T1" uid="uid-T1">
              <dexpi:port id="T1_MI1_port" name="MI1" portType="MaterialPort" direction="Inlet" label="MI1"/>
              <dexpi:components property="DesignMargin">
                <dexpi:object type="Core/QualifiedValue">
                  <dexpi:data property="Value">10</dexpi:data>
                </dexpi:object>
              </dexpi:components>
            </dexpi:element>
          </extensionElements>
        </task>
        ${startEvent('SE1', 'Feed')}
        ${endEvent('EE1', 'Product')}
        ${seqFlow('F1', 'SE1', 'T1')}
        ${seqFlow('F2', 'T1', 'EE1')}
      `);
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);

      expect(out).toContain('property="Ports"');
      expect(out).toContain('property="DesignMargin"');
      const parsed = new DOMParser().parseFromString(out, 'text/xml');
      expect(parsed.querySelector('parsererror')).toBeNull();
    });
  });

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
      // Assert real shape — not just `typeof string` (the return type
      // already guarantees that) and `length > 0` (any XML prologue
      // satisfies it). A regression that emits 38 bytes of useless
      // <?xml ...?> with no <Model> envelope must fail here.
      const parsed = new DOMParser().parseFromString(out, 'text/xml');
      expect(parsed.querySelector('parsererror')).toBeNull();
      const root = parsed.documentElement;
      expect(root.localName || root.tagName.split(':').pop()).toBe('Model');
      // The ProcessSteps container exists but holds no step Objects.
      const processStepsContainers = Array.from(parsed.querySelectorAll('Components'))
        .filter(c => c.getAttribute('property') === 'ProcessSteps');
      // ProcessSteps Components may or may not be emitted when empty;
      // the strong assertion is that no <Object> with a step type is
      // present in the document at all.
      const stepObjects = Array.from(parsed.querySelectorAll('Object'))
        .filter(o => /Process\.(ProcessStep|Source|Sink|.*ing)$/.test(o.getAttribute('type') ?? ''));
      expect(stepObjects).toHaveLength(0);
      // If a ProcessSteps Components element was emitted, it must be
      // empty (no direct <Object> children).
      for (const c of processStepsContainers) {
        const direct = Array.from(c.children).filter(
          el => (el.localName || el.tagName.split(':').pop()) === 'Object'
        );
        expect(direct).toHaveLength(0);
      }
    });
  });

  // ── unannotated task behaviour ────────────────────────────────────────────
  describe('unvalidated tasks default to ProcessStep', () => {
    const taskNames = [
      'ReactingChemicals',
      'reacting chemicals',
      'Compressing',
      'StrippingDistilling',
      'Widget Assembly Line 3',
    ];

    taskNames.forEach((taskName) => {
      it(`plain task "${taskName}" → ProcessStep + unvalidated warning`, async () => {
        const xml = bpmn(`
          ${plainTask('T1', taskName)}
          ${startEvent('SE1', 'Feed')}
          ${endEvent('EE1', 'End')}
          ${seqFlow('F1', 'SE1', 'T1')}
          ${seqFlow('F2', 'T1', 'EE1')}
        `);
        const t = new BpmnToDexpiTransformer();
        const out = await t.transform(xml);

        // Always ProcessStep — no name inference
        expect(out).toContain('ProcessStep');
        // Always warns about missing annotation
        expect(t.logger.warnings.length).toBeGreaterThan(0);
        expect(t.logger.warnings.some(w => /no dexpiType annotation/i.test(w))).toBe(true);
      });
    });
  });
});

// ── InformationFlow (Association) tests ───────────────────────────────────
describe('InformationFlow extraction from associations', () => {
  it('skips InformationFlow emission when an instrumentation activity is involved (DEXPI 2.0 schema-correct)', async () => {
    // Per DEXPI 2.0 (Spec PDF p.876, p.910, p.917): InstrumentationActivity is
    // a sibling of ProcessStep, not a subclass; only ProcessStep declares the
    // Ports composition, and InformationFlow Source/Target must point at
    // InformationPorts which only exist on ProcessSteps. So a flow whose
    // endpoints are an InstrumentationActivity cannot be modelled as an
    // InformationFlow object — it's expressed via the InstrumentationActivity's
    // ProcessStepReference / Setpoint / OutputValue / etc. instead.
    const xml = bpmn(`
      <task id="T1" name="MeasuringProcessVariable">
        <extensionElements>
          <dexpi:element dexpiType="MeasuringProcessVariable" identifier="T1" uid="uid_T1"/>
        </extensionElements>
      </task>
      <task id="T2" name="ReactingChemicals">
        <extensionElements>
          <dexpi:element dexpiType="ReactingChemicals" identifier="T2" uid="uid_T2"/>
        </extensionElements>
      </task>
      <association id="A1" name="signal" sourceRef="T1" targetRef="T2">
        <extensionElements>
          <dexpi:Stream streamType="InformationFlow" uid="uid_A1" identifier="IF-001"/>
        </extensionElements>
      </association>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2" sourceRef="T1" targetRef="T2"/>
      <sequenceFlow id="F3" sourceRef="T2" targetRef="EE1"/>
    `);

    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);

    expect(out).not.toContain('Process/Process.InformationFlow');
    expect(out).not.toContain('IF-001');
  });

  it('ignores plain associations without InformationFlow annotation', async () => {
    const xml = bpmn(`
      <task id="T1" name="Pumping">
        <extensionElements>
          <dexpi:element dexpiType="Pumping" identifier="T1" uid="uid_T1"/>
        </extensionElements>
      </task>
      <association id="A1" sourceRef="T1" targetRef="T1"/>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2" sourceRef="T1" targetRef="EE1"/>
    `);

    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);

    expect(out).not.toContain('InformationFlow');
  });

  it('warns when a ProcessStep-to-ProcessStep InformationFlow has no InformationPorts on either end', async () => {
    // For genuine ProcessStep-to-ProcessStep information links (no
    // instrumentation activity in between), InformationFlow remains the
    // schema-correct DEXPI representation, with Source/Target pointing
    // at InformationPorts on the two ProcessSteps. When the source BPMN
    // forgets to define those ports, the transformer emits a warning so
    // the user can repair the model.
    const xml = bpmn(`
      <task id="T1" name="ReactingChemicals">
        <extensionElements>
          <dexpi:element dexpiType="ReactingChemicals" identifier="T1" uid="uid_T1"/>
        </extensionElements>
      </task>
      <task id="T2" name="Separating">
        <extensionElements>
          <dexpi:element dexpiType="Separating" identifier="T2" uid="uid_T2"/>
        </extensionElements>
      </task>
      <association id="A1" sourceRef="T1" targetRef="T2">
        <extensionElements>
          <dexpi:Stream streamType="InformationFlow" uid="uid_A1" identifier="IF-001"/>
        </extensionElements>
      </association>
      ${startEvent('SE1')}${endEvent('EE1')}
      <sequenceFlow id="F1" sourceRef="SE1" targetRef="T1"/>
      <sequenceFlow id="F2" sourceRef="T1" targetRef="T2"/>
      <sequenceFlow id="F3" sourceRef="T2" targetRef="EE1"/>
    `);

    const t = new BpmnToDexpiTransformer();
    await t.transform(xml);

    expect(t.logger.warnings.some(w => w.includes('InformationPort'))).toBe(true);
  });
});

// ── Port-type-based stream type inference ─────────────────────────────────
describe('stream type inferred from port type when no streamType annotation', () => {
  const energyCases: [string, string, string, string][] = [
    ['ThermalEnergyPort',    'ThermalEnergyFlow',    'TEO1', 'TEI1'],
    ['MechanicalEnergyPort', 'MechanicalEnergyFlow', 'MEO1', 'MEI1'],
    ['ElectricalEnergyPort', 'ElectricalEnergyFlow', 'EEO1', 'EEI1'],
  ];

  energyCases.forEach(([portType, expectedDexpiType, outPort, inPort]) => {
    it(`${portType} ports → ${expectedDexpiType} in output`, async () => {
      const xml = bpmn(`
        <task id="T1" name="Source">
          <extensionElements>
            <dexpi:element dexpiType="Source" identifier="T1" uid="uid_T1">
              <dexpi:port portId="T1_${outPort}" name="${outPort}" portType="${portType}" direction="Outlet"/>
            </dexpi:element>
          </extensionElements>
        </task>
        <task id="T2" name="Sink">
          <extensionElements>
            <dexpi:element dexpiType="Sink" identifier="T2" uid="uid_T2">
              <dexpi:port portId="T2_${inPort}" name="${inPort}" portType="${portType}" direction="Inlet"/>
            </dexpi:element>
          </extensionElements>
        </task>
        ${startEvent('SE1')}${endEvent('EE1')}
        <sequenceFlow id="F0" sourceRef="SE1" targetRef="T1"/>
        <sequenceFlow id="F1" sourceRef="T1" targetRef="T2"/>
        <sequenceFlow id="F2" sourceRef="T2" targetRef="EE1"/>
      `);
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(xml);
      expect(out).toContain(`Process/Process.${expectedDexpiType}`);
    });
  });
});

/**
 * Regression: bpmn-moddle's serialiser applies the moddle's
 * `tagAlias: lowerCase` rule on output, so a fixture that round-trips
 * through bpmn-js's saveXML emits `<dexpi:materialStateType>` (lowerCase
 * first letter) where the original was `<dexpi:MaterialStateType>`.
 *
 * The reader path used to hard-code PascalCase matches for several
 * Material* / Composition / Flow / MoleFlow elements and silently
 * dropped the lowerCase forms — surfacing as N missing
 * MaterialStateType.MoleFlow findings in the consistency check on
 * any UI-saved file. This test feeds a minimal MaterialStateType +
 * Composition pair in BOTH casing conventions and asserts that the
 * MoleFlow `<Components>` carrier survives both.
 */
describe('Case-tolerant localName matches (bpmn-moddle round-trip)', () => {
  const buildBpmn = (msTag: string, mstTag: string, compTag: string) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
             targetNamespace="http://example.com/bpmn">
  <process id="P1">
    <dataObjectReference id="DOR_states" name="Base Case MaterialStates" dataObjectRef="DO1">
      <extensionElements>
        <dexpi:${msTag} uid="uuid_MS_S1">
          <dexpi:data property="Identifier">1</dexpi:data>
          <dexpi:data property="Label">Feed</dexpi:data>
          <dexpi:references property="State" uidRef="uuid_MS_S1_MST"/>
        </dexpi:${msTag}>
        <dexpi:${mstTag} uid="uuid_MS_S1_MST">
          <dexpi:data property="Identifier">1-State</dexpi:data>
          <dexpi:components property="MoleFlow">
            <dexpi:object type="Core/QualifiedValue">
              <dexpi:data property="Value">11.2</dexpi:data>
              <dexpi:data property="Unit">KilomolePerHour</dexpi:data>
            </dexpi:object>
          </dexpi:components>
          <dexpi:references property="Composition" uidRef="uuid_MS_S1_C"/>
        </dexpi:${mstTag}>
        <dexpi:${compTag} uid="uuid_MS_S1_C">
          <dexpi:data property="Display">Fraction</dexpi:data>
        </dexpi:${compTag}>
      </extensionElements>
    </dataObjectReference>
    <dataObject id="DO1"/>
  </process>
</definitions>`;

  it('reads MaterialState + MaterialStateType + Composition in both PascalCase and lowerCase', async () => {
    for (const [ms, mst, comp, label] of [
      ['MaterialState', 'MaterialStateType', 'Composition', 'PascalCase (raw fixture form)'] as const,
      ['materialState', 'materialStateType', 'composition', 'lowerCase (bpmn-moddle round-tripped form)'] as const,
    ]) {
      const t = new BpmnToDexpiTransformer();
      const out = await t.transform(buildBpmn(ms, mst, comp));
      expect(out, `${label}: MaterialState emitted`).toContain('Process/Process.MaterialState');
      expect(out, `${label}: MaterialStateType emitted`).toContain('Process/Process.MaterialStateType');
      expect(out, `${label}: MoleFlow components carrier preserved`).toMatch(/property="MoleFlow"/);
    }
  });
});

describe('ProcessStep.Description from bpmn:documentation', () => {
  /** Returns the Description <Data> child of the Object with the given id. */
  function descriptionOf(out: string, objectId: string): Element | null {
    const doc = new DOMParser().parseFromString(out, 'text/xml');
    const obj = Array.from(doc.getElementsByTagName('Object')).find(o => o.getAttribute('id') === objectId);
    if (!obj) return null;
    return Array.from(obj.children).find(c =>
      c.tagName === 'Data' && c.getAttribute('property') === 'Description') ?? null;
  }

  /** Text carried by a MultiLanguageString-shaped Description, or null. */
  function multiLanguageText(data: Element | null): string | null {
    const agg = data && Array.from(data.children).find(c =>
      c.tagName === 'AggregatedDataValue' && c.getAttribute('type') === 'Core/DataTypes.MultiLanguageString');
    const value = agg?.querySelector('Data[property="Value"] > String');
    return value?.textContent ?? null;
  }

  it('emits documentation as a MultiLanguageString Description on an ordinary ProcessStep', async () => {
    const xml = bpmn(`
      <task id="T1" name="Pumping">
        <documentation>Transfers feed &amp; recycle to the reactor</documentation>
        <extensionElements>
          <dexpi:element dexpiType="Pumping" identifier="T1" uid="uid-T1"/>
        </extensionElements>
      </task>
      ${startEvent('SE1', 'Feed')}
      ${endEvent('EE1', 'Product')}
      ${seqFlow('F1', 'SE1', 'T1')}
      ${seqFlow('F2', 'T1', 'EE1')}
    `);
    const out = await new BpmnToDexpiTransformer().transform(xml);

    const description = descriptionOf(out, 'uid_T1');
    expect(description).not.toBeNull();
    expect(multiLanguageText(description)).toBe('Transfers feed & recycle to the reactor');
    expect(description!.querySelector('Data[property="Language"] > String')?.textContent).toBe('en');
    // Exactly one Description (upper=1), and no plain-String variant.
    expect(Array.from(description!.children).map(c => c.tagName)).toEqual(['AggregatedDataValue']);
  });

  it('emits Description on Source and Sink events from their documentation', async () => {
    const xml = bpmn(`
      ${annotatedTask('T1', 'Mixing', 'Mixing')}
      <startEvent id="SE1" name="Feed">
        <documentation>Fresh feed from tank farm</documentation>
        <extensionElements>
          <dexpi:element dexpiType="Source" identifier="SE1" uid="uid-SE1"/>
        </extensionElements>
        <outgoing>F1</outgoing>
      </startEvent>
      <endEvent id="EE1" name="Product">
        <documentation>To product storage</documentation>
        <extensionElements>
          <dexpi:element dexpiType="Sink" identifier="EE1" uid="uid-EE1"/>
        </extensionElements>
        <incoming>F2</incoming>
      </endEvent>
      ${seqFlow('F1', 'SE1', 'T1')}
      ${seqFlow('F2', 'T1', 'EE1')}
    `);
    const out = await new BpmnToDexpiTransformer().transform(xml);
    expect(multiLanguageText(descriptionOf(out, 'uid_SE1'))).toBe('Fresh feed from tank farm');
    expect(multiLanguageText(descriptionOf(out, 'uid_EE1'))).toBe('To product storage');
    expect(descriptionOf(out, 'uid_T1')).toBeNull();
  });

  it('emits no Description when the step has no documentation', async () => {
    const xml = bpmn(`
      ${annotatedTask('T1', 'Pumping', 'Pumping')}
      ${startEvent('SE1', 'Feed')}
      ${endEvent('EE1', 'Product')}
      ${seqFlow('F1', 'SE1', 'T1')}
      ${seqFlow('F2', 'T1', 'EE1')}
    `);
    const out = await new BpmnToDexpiTransformer().transform(xml);
    expect(descriptionOf(out, 'uid_T1')).toBeNull();
    expect(descriptionOf(out, 'uid_SE1')).toBeNull();
  });

  it('prefers documentation over the name for an InstrumentationActivity Description', async () => {
    const xml = bpmn(`
      ${annotatedTask('T1', 'Heating', 'Heating')}
      <task id="M1" name="TI-101">
        <documentation>Reactor outlet temperature indication</documentation>
        <extensionElements>
          <dexpi:element dexpiType="MeasuringProcessVariable" identifier="M1" uid="uid-M1"/>
        </extensionElements>
      </task>
      ${startEvent('SE1', 'Feed')}
      ${endEvent('EE1', 'Product')}
      ${seqFlow('F1', 'SE1', 'T1')}
      ${seqFlow('F2', 'T1', 'EE1')}
    `);
    const out = await new BpmnToDexpiTransformer().transform(xml);
    const description = descriptionOf(out, 'uid_M1');
    expect(multiLanguageText(description)).toBe('Reactor outlet temperature indication');
    // The name still goes out as Label, but is no longer the Description.
    expect(description!.textContent).not.toContain('TI-101');
  });

  it('drops a duplicate Description attribute in favour of documentation and warns', async () => {
    const xml = bpmn(`
      <task id="T1" name="Pumping">
        <documentation>From documentation</documentation>
        <extensionElements>
          <dexpi:element dexpiType="Pumping" identifier="T1" uid="uid-T1">
            <dexpi:data property="Description">From attribute editor</dexpi:data>
          </dexpi:element>
        </extensionElements>
      </task>
      ${startEvent('SE1', 'Feed')}
      ${endEvent('EE1', 'Product')}
      ${seqFlow('F1', 'SE1', 'T1')}
      ${seqFlow('F2', 'T1', 'EE1')}
    `);
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(xml);
    const doc = new DOMParser().parseFromString(out, 'text/xml');
    const obj = Array.from(doc.getElementsByTagName('Object')).find(o => o.getAttribute('id') === 'uid_T1')!;
    const descriptions = Array.from(obj.children).filter(c =>
      c.tagName === 'Data' && c.getAttribute('property') === 'Description');
    expect(descriptions).toHaveLength(1);
    expect(multiLanguageText(descriptions[0])).toBe('From documentation');
    expect(t.logger.warnings.some(w => w.includes(`attribute "Description" ignored`))).toBe(true);
  });
});

describe('ProcessStep.HierarchyLevel', () => {
  const ENUM = 'Process/Enumerations.ProcessStepHierarchyLevel';

  /** Literal of the HierarchyLevel DataReference on an Object, or null when absent. */
  function levelOf(out: string, objectId: string): string | null {
    const doc = new DOMParser().parseFromString(out, 'text/xml');
    const obj = Array.from(doc.getElementsByTagName('Object')).find(o => o.getAttribute('id') === objectId);
    const data = obj && Array.from(obj.children).filter(c =>
      c.tagName === 'Data' && c.getAttribute('property') === 'HierarchyLevel');
    if (!data || data.length === 0) return null;
    expect(data).toHaveLength(1); // lower=0, upper=1
    const ref = data[0].querySelector(':scope > DataReference')?.getAttribute('data') ?? '';
    expect(ref.startsWith(`${ENUM}.`)).toBe(true);
    return ref.slice(ENUM.length + 1);
  }

  /** subProcess "SP1" holding a Source proxy, a task and a Sink proxy. */
  function section(extra = '', childExtra = ''): string {
    return `
      <subProcess id="SP1" name="Section">
        <extensionElements>
          <dexpi:element dexpiType="ReactingChemicals" identifier="SP1" uid="uid-SP1" ${extra}/>
        </extensionElements>
        <startEvent id="SE_in" name="In">
          <extensionElements><dexpi:element dexpiType="Source" identifier="SE_in" uid="uid-SE_in"/></extensionElements>
        </startEvent>
        <task id="T1" name="Pump">
          <extensionElements>
            <dexpi:element dexpiType="Pumping" identifier="T1" uid="uid-T1" ${childExtra}/>
          </extensionElements>
        </task>
        <endEvent id="EE_out" name="Out">
          <extensionElements><dexpi:element dexpiType="Sink" identifier="EE_out" uid="uid-EE_out"/></extensionElements>
        </endEvent>
      </subProcess>`;
  }

  async function exportOf(body: string): Promise<{ out: string; t: BpmnToDexpiTransformer }> {
    const t = new BpmnToDexpiTransformer();
    return { out: await t.transform(bpmn(body)), t };
  }

  it('derives ProcessSection for a step with SubProcessSteps and UnitOperation for its leaves', async () => {
    const { out } = await exportOf(`${section()}
      ${annotatedTask('T2', 'Mixing', 'Mixing')}`);
    expect(levelOf(out, 'uid_SP1')).toBe('ProcessSection');
    expect(levelOf(out, 'uid_T1')).toBe('UnitOperation');
    // A leaf on the root plane is a UnitOperation too.
    expect(levelOf(out, 'uid_T2')).toBe('UnitOperation');
  });

  it('gives root-plane Source and Sink UnitOperation, and nested boundary Source/Sink none', async () => {
    const { out } = await exportOf(`${section()}
      ${startEvent('SE1', 'Feed')}
      ${endEvent('EE1', 'Product')}`);
    expect(levelOf(out, 'uid_SE1')).toBe('UnitOperation');
    expect(levelOf(out, 'uid_EE1')).toBe('UnitOperation');
    expect(levelOf(out, 'uid_SE_in')).toBeNull();
    expect(levelOf(out, 'uid_EE_out')).toBeNull();
  });

  it('lets an explicit dexpi:element hierarchyLevel override the structural default', async () => {
    const { out, t } = await exportOf(
      section('hierarchyLevel="ProcessTrain"', 'hierarchyLevel="ControlFunction"'));
    expect(levelOf(out, 'uid_SP1')).toBe('ProcessTrain');
    expect(levelOf(out, 'uid_T1')).toBe('ControlFunction');
    expect(t.logger.warnings.filter(w => w.includes('hierarchyLevel'))).toEqual([]);
  });

  it('applies an explicit level to a leaf that the default would call a UnitOperation, and to a nested proxy', async () => {
    const body = `<subProcess id="SP1" name="Section">
        <extensionElements><dexpi:element dexpiType="ReactingChemicals" identifier="SP1" uid="uid-SP1"/></extensionElements>
        <startEvent id="SE_in" name="In">
          <extensionElements><dexpi:element dexpiType="Source" identifier="SE_in" uid="uid-SE_in" hierarchyLevel="ElementaryFunction"/></extensionElements>
        </startEvent>
        ${annotatedTask('T1', 'Pump', 'Pumping')}
      </subProcess>`;
    const { out } = await exportOf(body);
    expect(levelOf(out, 'uid_SE_in')).toBe('ElementaryFunction');
  });

  it('falls back to the default and warns when hierarchyLevel is not an enumeration literal', async () => {
    const { out, t } = await exportOf(section('hierarchyLevel="Plant"'));
    expect(levelOf(out, 'uid_SP1')).toBe('ProcessSection');
    expect(t.logger.warnings.some(w => w.includes('hierarchyLevel "Plant"'))).toBe(true);
  });

  it('is deterministic: exporting twice yields the same levels', async () => {
    const body = section();
    const a = await exportOf(body);
    const b = await exportOf(body);
    for (const id of ['uid_SP1', 'uid_T1', 'uid_SE_in']) expect(levelOf(a.out, id)).toBe(levelOf(b.out, id));
  });
});
