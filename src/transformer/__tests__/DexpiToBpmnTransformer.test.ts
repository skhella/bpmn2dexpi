import { describe, it, expect } from 'vitest';
import { DexpiToBpmnTransformer } from '../DexpiToBpmnTransformer';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';

// Minimal DEXPI XML helper
function dexpi(steps: string, connections = '', materialTemplates = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Model name="process_model" uri="http://www.example.org">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="pm1" type="Process/ProcessModel">
        <Components property="ProcessSteps">
${steps}
        </Components>
        ${connections ? `<Components property="ProcessConnections">${connections}</Components>` : ''}
        ${materialTemplates ? `<Components property="MaterialTemplates">${materialTemplates}</Components>` : ''}
      </Object>
    </Components>
  </Object>
</Model>`;
}

function step(id: string, type: string, label: string, ports = ''): string {
  return `
        <Object id="${id}" type="Process/Process.${type}">
          <Data property="Identifier"><String>${id}</String></Data>
          <Data property="Label"><String>${label}</String></Data>
          ${ports ? `<Components property="Ports">${ports}</Components>` : ''}
        </Object>`;
}

function subProcessStep(id: string, type: string, label: string, children: string, ports = ''): string {
  return `
        <Object id="${id}" type="Process/Process.${type}">
          <Data property="Identifier"><String>${id}</String></Data>
          <Data property="Label"><String>${label}</String></Data>
          ${ports ? `<Components property="Ports">${ports}</Components>` : ''}
          <Components property="SubProcessSteps">
${children}
          </Components>
        </Object>`;
}

function port(id: string, type: string, direction: 'In' | 'Out', label: string): string {
  return `
            <Object id="${id}" type="Process/Process.${type}">
              <Data property="Identifier"><String>${id}</String></Data>
              <Data property="Label"><String>${label}</String></Data>
              <Data property="NominalDirection">
                <DataReference data="Process/Enumerations.PortDirectionClassification.${direction}"/>
              </Data>
            </Object>`;
}

function stream(id: string, type: string, srcPort: string, tgtPort: string, label = ''): string {
  return `
        <Object id="${id}" type="Process/Process.${type}">
          <Data property="Identifier"><String>${id}</String></Data>
          ${label ? `<Data property="Label"><String>${label}</String></Data>` : ''}
          <References property="Source" objects="#${srcPort}"/>
          <References property="Target" objects="#${tgtPort}"/>
        </Object>`;
}

function expectWellFormedXml(xml: string): void {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('parsererror')?.textContent || '').toBe('');
}

describe('DexpiToBpmnTransformer', () => {

  describe('basic structure', () => {
    it('produces valid BPMN XML with required namespaces', () => {
      const xml = dexpi(step('SE1', 'Source', 'Feed') + step('EE1', 'Sink', 'Product'));
      const t = new DexpiToBpmnTransformer();
      const out = t.transform(xml);

      expect(out).toContain('xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"');
      expect(out).toContain('xmlns:bpmndi=');
      expect(out).toContain('xmlns:dexpi=');
      expect(out).toContain('bpmndi:BPMNDiagram');
      expect(out).toContain('bpmndi:BPMNPlane');
    });

    it('throws if no ProcessModel found', () => {
      const t = new DexpiToBpmnTransformer();
      expect(() => t.transform('<Model><bad/></Model>')).toThrow('No ProcessModel found');
    });
  });

  describe('step type mapping', () => {
    it('maps Source → bpmn:startEvent', () => {
      const xml = dexpi(step('SE1', 'Source', 'Feed'));
      const out = new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:startEvent');
      expect(out).toContain('dexpiType="Source"');
    });

    it('maps Sink → bpmn:endEvent', () => {
      const xml = dexpi(step('EE1', 'Sink', 'Product'));
      const out = new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:endEvent');
      expect(out).toContain('dexpiType="Sink"');
    });

    it('maps Pumping → bpmn:task', () => {
      const xml = dexpi(step('T1', 'Pumping', 'Feed Pump'));
      const out = new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:task');
      expect(out).toContain('dexpiType="Pumping"');
      expect(out).toContain('name="Feed Pump"');
    });

    it('preserves uid and identifier as extensionElements', () => {
      const xml = dexpi(step('uid_pump1', 'Pumping', 'P-101'));
      const out = new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('uid="uid_pump1"');
      expect(out).toContain('identifier="uid_pump1"');
    });
  });

  describe('subprocess mapping', () => {
    it('maps nested SubProcessSteps to a collapsed bpmn:subProcess', () => {
      const xml = dexpi(
        subProcessStep(
          'RC1',
          'ReactingChemicals',
          'Reactor section',
          step('MX1', 'Mixing', 'Mixer') + step('RX1', 'ReactingChemicals', 'Reactor')
        )
      );
      const out = new DexpiToBpmnTransformer().transform(xml);

      const parentStart = out.indexOf('<bpmn:subProcess id="bpmn_RC1"');
      const childTask = out.indexOf('<bpmn:task id="bpmn_MX1"');
      const parentEnd = out.indexOf('</bpmn:subProcess>', parentStart);

      expect(parentStart).toBeGreaterThan(-1);
      expect(out).toContain('isExpanded="false"');
      expect(childTask).toBeGreaterThan(parentStart);
      expect(childTask).toBeLessThan(parentEnd);
      expect(out).not.toContain('id="bpmn_MX1_di"');
      expect(out).toContain('dexpiType="ReactingChemicals"');
      expect(out).toContain('dexpiType="Mixing"');
    });

    it('places sequence flows between sibling subprocess children inside the subprocess', () => {
      const c1Ports = port('MX_out', 'MaterialPort', 'Out', 'MO1');
      const c2Ports = port('RX_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        subProcessStep(
          'RC1',
          'ReactingChemicals',
          'Reactor section',
          step('MX1', 'Mixing', 'Mixer', c1Ports) + step('RX1', 'ReactingChemicals', 'Reactor', c2Ports)
        ),
        stream('S_internal', 'Stream', 'MX_out', 'RX_in')
      );
      const out = new DexpiToBpmnTransformer().transform(xml);

      const parentStart = out.indexOf('<bpmn:subProcess id="bpmn_RC1"');
      const internalFlow = out.indexOf('<bpmn:sequenceFlow id="bpmn_S_internal"');
      const parentEnd = out.indexOf('</bpmn:subProcess>', parentStart);

      expect(internalFlow).toBeGreaterThan(parentStart);
      expect(internalFlow).toBeLessThan(parentEnd);
      expect(out).not.toContain('id="bpmn_S_internal_di"');
      expect(out).toContain('<bpmn:outgoing>bpmn_S_internal</bpmn:outgoing>');
      expect(out).toContain('<bpmn:incoming>bpmn_S_internal</bpmn:incoming>');
    });

    it('also recognizes nested ProcessModel containers as subprocess children', () => {
      const nestedProcessModelStep = `
        <Object id="RC1" type="Process/Process.ReactingChemicals">
          <Data property="Identifier"><String>RC1</String></Data>
          <Data property="Label"><String>Reactor section</String></Data>
          <Components property="ProcessModel">
            <Object id="PM_child" type="Process/ProcessModel">
              <Components property="ProcessSteps">
${step('MX1', 'Mixing', 'Mixer')}
              </Components>
            </Object>
          </Components>
        </Object>`;
      const xml = dexpi(nestedProcessModelStep);
      const out = new DexpiToBpmnTransformer().transform(xml);

      expect(out).toContain('<bpmn:subProcess id="bpmn_RC1"');
      expect(out).toContain('<bpmn:task id="bpmn_MX1"');
    });
  });

  describe('port mapping', () => {
    it('recreates ports as dexpi:port in extensionElements', () => {
      const ports = port('p1', 'MaterialPort', 'In', 'MI1') + port('p2', 'MaterialPort', 'Out', 'MO1');
      const xml = dexpi(step('T1', 'Pumping', 'Pump', ports));
      const out = new DexpiToBpmnTransformer().transform(xml);
      expectWellFormedXml(out);
      expect(out).toContain('portType="MaterialPort"');
      expect(out).toContain('direction="Inlet"');
      expect(out).toContain('direction="Outlet"');
    });
  });

  describe('connection mapping', () => {
    it('maps MaterialFlow Stream → bpmn:sequenceFlow', () => {
      const p1 = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const p2 = port('T1_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', p1) + step('T1', 'Pumping', 'Pump', p2),
        stream('S1', 'Stream', 'SE_out', 'T1_in', 'feed')
      );
      const out = new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:sequenceFlow');
      expect(out).toContain('dexpi:Stream');
    });

    it('maps ThermalEnergyFlow → sequenceFlow with streamType', () => {
      const p1 = port('src_out', 'ThermalEnergyPort', 'Out', 'TEO1');
      const p2 = port('tgt_in', 'ThermalEnergyPort', 'In', 'TEI1');
      const xml = dexpi(
        step('S1', 'Source', 'Steam', p1) + step('T1', 'ExchangingThermalEnergy', 'HX', p2),
        stream('E1', 'ThermalEnergyFlow', 'src_out', 'tgt_in')
      );
      const out = new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('streamType="ThermalEnergyFlow"');
    });

    it('maps InformationFlow → bpmn:association + DataObjectReference', () => {
      const p1 = port('ia_out', 'InformationPort', 'Out', 'IO1');
      const p2 = port('ps_in', 'InformationPort', 'In', 'II1');
      const infoStream = `
        <Object id="IF1" type="Process/Process.InformationFlow">
          <Data property="Identifier"><String>IF1</String></Data>
          <References property="Source" objects="#ia_out"/>
          <References property="Target" objects="#ps_in"/>
          <Components property="InformationValue">
            <Object type="Process/Process.InformationVariant">
              <Data property="Label"><String>Temperature</String></Data>
            </Object>
          </Components>
        </Object>`;
      const xml = dexpi(
        step('IA1', 'MeasuringProcessVariable', 'TI-101', p1) + step('PS1', 'ReactingChemicals', 'Reactor', p2),
        infoStream
      );
      const out = new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:association');
      expect(out).toContain('bpmn:dataObjectReference');
      expect(out).toContain('name="Temperature"');
    });
  });

  describe('layout', () => {
    it('assigns distinct x/y positions to all elements', () => {
      const p1 = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const p2 = port('T1_in', 'MaterialPort', 'In', 'MI1');
      const p3 = port('T1_out', 'MaterialPort', 'Out', 'MO1');
      const p4 = port('EE_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', p1) + step('T1', 'Pumping', 'Pump', p2 + p3) + step('EE1', 'Sink', 'Out', p4),
        stream('S1', 'Stream', 'SE_out', 'T1_in') + stream('S2', 'Stream', 'T1_out', 'EE_in')
      );
      const out = new DexpiToBpmnTransformer().transform(xml);
      // Extract all dc:Bounds x values — should have multiple distinct values
      const bounds = [...out.matchAll(/dc:Bounds x="(\d+)"/g)].map(m => Number(m[1]));
      const unique = new Set(bounds);
      expect(unique.size).toBeGreaterThan(1);
      // Source should be leftmost
      expect(Math.min(...bounds)).toBeGreaterThanOrEqual(100);
    });
  });

  describe('round-trip', () => {
    it('BPMN → DEXPI → BPMN preserves step types and extensionElements', async () => {
      const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:dexpi="http://dexpi.org/bpmn-extension/1.0" id="D1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P1">
    <bpmn:startEvent id="SE1"><bpmn:extensionElements><dexpi:element dexpiType="Source" identifier="SE1" uid="uid_SE1"/></bpmn:extensionElements><bpmn:outgoing>F1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="T1" name="Pumping"><bpmn:extensionElements><dexpi:element dexpiType="Pumping" identifier="T1" uid="uid_T1"><dexpi:port portId="T1_MI1" name="MI1" portType="MaterialPort" direction="Inlet"/><dexpi:port portId="T1_MO1" name="MO1" portType="MaterialPort" direction="Outlet"/></dexpi:element></bpmn:extensionElements><bpmn:incoming>F1</bpmn:incoming><bpmn:outgoing>F2</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="EE1"><bpmn:extensionElements><dexpi:element dexpiType="Sink" identifier="EE1" uid="uid_EE1"/></bpmn:extensionElements><bpmn:incoming>F2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="SE1" targetRef="T1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T1" targetRef="EE1"/>
  </bpmn:process>
</bpmn:definitions>`;

      const dexpiXml = await new BpmnToDexpiTransformer().transform(bpmn);
      const bpmn2 = new DexpiToBpmnTransformer().transform(dexpiXml);

      // Step types are preserved through the round-trip
      expect(bpmn2).toContain('dexpiType="Pumping"');
      expect(bpmn2).toContain('dexpiType="Source"');
      expect(bpmn2).toContain('dexpiType="Sink"');
      // Ports are recreated
      expect(bpmn2).toContain('portType="MaterialPort"');
      // UIDs are preserved
      expect(bpmn2).toContain('uid="uid_T1"');
    });
  });
});
