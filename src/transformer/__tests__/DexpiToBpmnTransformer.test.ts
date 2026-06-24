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

function portWithRefs(
  id: string,
  type: string,
  direction: 'In' | 'Out',
  label: string,
  refs: { sub?: string[]; super?: string } = {}
): string {
  const references = [
    refs.sub && refs.sub.length > 0
      ? `<References property="SubReference" objects="${refs.sub.map(ref => `#${ref}`).join(' ')}"/>`
      : '',
    refs.super
      ? `<References property="SuperReference" objects="#${refs.super}"/>`
      : '',
  ].filter(Boolean).join('\n              ');

  return `
            <Object id="${id}" type="Process/Process.${type}">
              <Data property="Identifier"><String>${id}</String></Data>
              <Data property="Label"><String>${label}</String></Data>
              <Data property="NominalDirection">
                <DataReference data="Process/Enumerations.PortDirectionClassification.${direction}"/>
              </Data>
              ${references}
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
    it('produces valid BPMN XML with required namespaces', async () => {
      const xml = dexpi(step('SE1', 'Source', 'Feed') + step('EE1', 'Sink', 'Product'));
      const t = new DexpiToBpmnTransformer();
      const out = await t.transform(xml);

      expect(out).toContain('xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"');
      expect(out).toContain('xmlns:bpmndi=');
      expect(out).toContain('xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"');
      expect(out).toContain('bpmndi:BPMNDiagram');
      expect(out).toContain('bpmndi:BPMNPlane');
    });

    it('throws if no ProcessModel found', async () => {
      const t = new DexpiToBpmnTransformer();
      await expect(t.transform('<Model><bad/></Model>')).rejects.toThrow('No ProcessModel found');
    });
  });

  describe('step type mapping', () => {
    it('maps Source → bpmn:startEvent', async () => {
      const xml = dexpi(step('SE1', 'Source', 'Feed'));
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:startEvent');
      expect(out).toContain('dexpiType="Source"');
    });

    it('maps Sink → bpmn:endEvent', async () => {
      const xml = dexpi(step('EE1', 'Sink', 'Product'));
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:endEvent');
      expect(out).toContain('dexpiType="Sink"');
    });

    it('maps Pumping → bpmn:task', async () => {
      const xml = dexpi(step('T1', 'Pumping', 'Feed Pump'));
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:task');
      expect(out).toContain('dexpiType="Pumping"');
      expect(out).toContain('name="Feed Pump"');
    });

    it('preserves uid and identifier as extensionElements', async () => {
      const xml = dexpi(step('uid_pump1', 'Pumping', 'P-101'));
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('uid="uid_pump1"');
      expect(out).toContain('identifier="uid_pump1"');
    });

    it('omits Source/Sink steps that are only visual port proxies', async () => {
      const realSourcePort = port('ReactantA_out', 'MaterialPort', 'Out', 'MO1');
      const proxySourcePort = port('MI1_proxy_out', 'MaterialPort', 'Out', 'MI1');
      const taskPorts =
        port('Pump_in', 'MaterialPort', 'In', 'MI1') +
        port('Pump_out', 'MaterialPort', 'Out', 'MO1');
      const proxySinkPort = port('MO1_proxy_in', 'MaterialPort', 'In', 'MO1');
      const xml = dexpi(
        step('ReactantA', 'Source', 'Reactant A', realSourcePort) +
        step('MI1Proxy', 'Source', 'MI1', proxySourcePort) +
        step('Pump', 'Pumping', 'Pump', taskPorts) +
        step('MO1Proxy', 'Sink', 'MO1', proxySinkPort),
        stream('RealFeed', 'Stream', 'ReactantA_out', 'Pump_in') +
        stream('ProxyFeed', 'Stream', 'MI1_proxy_out', 'Pump_in') +
        stream('ProxyOut', 'Stream', 'Pump_out', 'MO1_proxy_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      expect(out).toContain('<bpmn:startEvent id="bpmn_ReactantA"');
      expect(out).toContain('<bpmn:sequenceFlow id="bpmn_RealFeed"');
      expect(out).not.toContain('id="bpmn_MI1Proxy"');
      expect(out).not.toContain('id="bpmn_MO1Proxy"');
      expect(out).not.toContain('id="bpmn_ProxyFeed"');
      expect(out).not.toContain('id="bpmn_ProxyOut"');
      expect(out).toContain('portId="Pump_in"');
      expect(out).toContain('portId="Pump_out"');
    });
  });

  describe('subprocess mapping', () => {
    it('maps nested SubProcessSteps to a collapsed bpmn:subProcess', async () => {
      const xml = dexpi(
        subProcessStep(
          'RC1',
          'ReactingChemicals',
          'Reactor section',
          step('MX1', 'Mixing', 'Mixer') + step('RX1', 'ReactingChemicals', 'Reactor')
        )
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      const parentStart = out.indexOf('<bpmn:subProcess id="bpmn_RC1"');
      const childTask = out.indexOf('<bpmn:task id="bpmn_MX1"');
      const parentEnd = out.indexOf('</bpmn:subProcess>', parentStart);

      expect(parentStart).toBeGreaterThan(-1);
      expect(out).toContain('isExpanded="false"');
      expect(childTask).toBeGreaterThan(parentStart);
      expect(childTask).toBeLessThan(parentEnd);
      expect(out).toContain('<bpmndi:BPMNPlane id="bpmn_RC1_plane" bpmnElement="bpmn_RC1">');
      expect(out).toContain('id="bpmn_MX1_di"');
      expect(out).toContain('dexpiType="ReactingChemicals"');
      expect(out).toContain('dexpiType="Mixing"');
    });

    it('places sequence flows between sibling subprocess children inside the subprocess', async () => {
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
      const out = await new DexpiToBpmnTransformer().transform(xml);

      const parentStart = out.indexOf('<bpmn:subProcess id="bpmn_RC1"');
      const internalFlow = out.indexOf('<bpmn:sequenceFlow id="bpmn_S_internal"');
      const parentEnd = out.indexOf('</bpmn:subProcess>', parentStart);

      expect(internalFlow).toBeGreaterThan(parentStart);
      expect(internalFlow).toBeLessThan(parentEnd);
      expect(out).toContain('id="bpmn_S_internal_di"');
      expect(out).toContain('<bpmn:outgoing>bpmn_S_internal</bpmn:outgoing>');
      expect(out).toContain('<bpmn:incoming>bpmn_S_internal</bpmn:incoming>');
    });

    it('places InformationFlow data objects in the owning subprocess plane', async () => {
      const infoOut = port('Sensor_out', 'InformationPort', 'Out', 'IPO_Temperature');
      const infoIn = port('Reactor_in', 'InformationPort', 'In', 'IPI_Temperature');
      const infoStream = `
        <Object id="IF_internal" type="Process/Process.InformationFlow">
          <Data property="Identifier"><String>IF_internal</String></Data>
          <References property="Source" objects="#Sensor_out"/>
          <References property="Target" objects="#Reactor_in"/>
          <Components property="InformationValue">
            <Object type="Process/Process.InformationVariant">
              <Data property="Label"><String>Temperature</String></Data>
            </Object>
          </Components>
        </Object>`;
      const xml = dexpi(
        subProcessStep(
          'RC1',
          'ReactingChemicals',
          'Reactor section',
          step('Sensor', 'MeasuringProcessVariable', 'TI-101', infoOut) +
            step('Reactor', 'ReactingChemicals', 'Reactor', infoIn)
        ),
        infoStream
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      const subprocessEnd = out.indexOf('</bpmn:subProcess>', out.indexOf('<bpmn:subProcess id="bpmn_RC1"'));
      const dataObject = out.indexOf('name="Temperature"');
      const subprocessPlane = out.indexOf('<bpmndi:BPMNPlane id="bpmn_RC1_plane"');
      const dataObjectShape = out.indexOf('bpmnElement="dobj_bpmn_Sensor_bpmn_Temperature"');

      expect(dataObject).toBeGreaterThan(-1);
      expect(dataObject).toBeLessThan(subprocessEnd);
      expect(dataObjectShape).toBeGreaterThan(subprocessPlane);
    });

    it('also recognizes nested ProcessModel containers as subprocess children', async () => {
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
      const out = await new DexpiToBpmnTransformer().transform(xml);

      expect(out).toContain('<bpmn:subProcess id="bpmn_RC1"');
      expect(out).toContain('<bpmn:task id="bpmn_MX1"');
    });

    it('synthesizes boundary Source/Sink events and skips peer-to-peer boundary ports', async () => {
      const parentPorts =
        portWithRefs('RC_MI1', 'MaterialPort', 'In', 'MI1', { sub: ['Reactor_MI1'] }) +
        port('RC_MO1', 'MaterialPort', 'Out', 'MO1') +
        portWithRefs('RC_TEI1', 'ThermalEnergyPort', 'In', 'TEI1', { sub: ['Reactor_TEI1'] }) +
        portWithRefs('RC_IPI_Temperature', 'InformationPort', 'In', 'IPI_Temperature', { sub: ['Reactor_IPI_Temperature'] });
      const reactorPorts =
        port('Reactor_MI1', 'MaterialPort', 'In', 'MI1') +
        port('Reactor_MO1', 'MaterialPort', 'Out', 'MO1') +
        portWithRefs('Reactor_TEI1', 'ThermalEnergyPort', 'In', 'TEI1', { super: 'RC_TEI1' }) +
        portWithRefs('Reactor_IPI_Temperature', 'InformationPort', 'In', 'IPI_Temperature', { super: 'RC_IPI_Temperature' });
      const heatPorts = port('Heater_TEO1', 'ThermalEnergyPort', 'Out', 'TEO1');
      const xml = dexpi(
        subProcessStep(
          'RC',
          'ReactingChemicals',
          'Reactor section',
          step('Reactor', 'ReactingChemicals', 'Reactor', reactorPorts),
          parentPorts
        ) +
          step('Heater', 'SupplyingThermalEnergy', 'Heater', heatPorts),
        stream('BoundaryOut', 'Stream', 'Reactor_MO1', 'RC_MO1') +
          stream('ThermalPeer', 'ThermalEnergyFlow', 'Heater_TEO1', 'RC_TEI1')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      expect(out).toContain('<bpmn:startEvent id="bpmn_RC_MI1_Source" name="MI1">');
      expect(out).toContain('<bpmn:endEvent id="bpmn_RC_MO1_Sink" name="MO1">');
      expect(out).toContain('portId="RC_MI1" name="MI1" portType="MaterialPort" direction="Inlet"');
      expect(out).toContain('subReference="RC_MI1_Source_MI1_port"');
      expect(out).toContain('portId="RC_MI1_Source_MI1_port" name="MI1" portType="MaterialPort" direction="Outlet"');
      expect(out).toContain('superReference="RC_MI1"');
      expect(out).toContain('sourcePortRef="RC_MI1_Source_MI1_port" targetPortRef="Reactor_MI1"');
      expect(out).toContain('sourcePortRef="Reactor_MO1" targetPortRef="RC_MO1_Sink_MO1_port"');
      expect(out).not.toContain('id="bpmn_BoundaryOut"');
      expect(out).not.toContain('bpmn_RC_TEI1_Source');
      expect(out).not.toContain('bpmn_RC_IPI_Temperature_Source');
      expect(out).toContain('id="bpmn_ThermalPeer"');
    });

    it('uses existing child Source/Sink boundary events instead of synthesizing duplicates', async () => {
      const parentPorts = portWithRefs('RC_MI1', 'MaterialPort', 'In', 'MI1', { sub: ['InnerSource_MO1'] });
      const sourcePorts = portWithRefs('InnerSource_MO1', 'MaterialPort', 'Out', 'MI1', { super: 'RC_MI1' });
      const reactorPorts = port('Reactor_MI1', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        subProcessStep(
          'RC',
          'ReactingChemicals',
          'Reactor section',
          step('InnerSource', 'Source', 'MI1', sourcePorts) +
            step('Reactor', 'ReactingChemicals', 'Reactor', reactorPorts),
          parentPorts
        ),
        stream('InnerFeed', 'Stream', 'InnerSource_MO1', 'Reactor_MI1')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      expect(out).toContain('<bpmn:startEvent id="bpmn_InnerSource" name="MI1">');
      expect(out).toContain('superReference="RC_MI1"');
      expect(out).toContain('subReference="InnerSource_MO1"');
      expect(out).not.toContain('bpmn_RC_MI1_Source');
      expect(out).toContain('sourcePortRef="InnerSource_MO1" targetPortRef="Reactor_MI1"');
    });

    it('adopts root-level boundary Source/Sink events into the referenced subprocess', async () => {
      const parentPorts =
        portWithRefs('RC_MI1', 'MaterialPort', 'In', 'MI1', { sub: ['RootSource_MO1'] }) +
        portWithRefs('RC_MO1', 'MaterialPort', 'Out', 'MO1', { sub: ['RootSink_MI1'] });
      const sourcePorts = portWithRefs('RootSource_MO1', 'MaterialPort', 'Out', 'MI1', { super: 'RC_MI1' });
      const sinkPorts = portWithRefs('RootSink_MI1', 'MaterialPort', 'In', 'MO1', { super: 'RC_MO1' });
      const reactorPorts =
        port('Reactor_MI1', 'MaterialPort', 'In', 'MI1') +
        port('Reactor_MO1', 'MaterialPort', 'Out', 'MO1');
      const xml = dexpi(
        subProcessStep(
          'RC',
          'ReactingChemicals',
          'Reactor section',
          step('Reactor', 'ReactingChemicals', 'Reactor', reactorPorts),
          parentPorts
        ) +
          step('RootSource', 'Source', 'MI1', sourcePorts) +
          step('RootSink', 'Sink', 'MO1', sinkPorts),
        stream('InnerFeed', 'Stream', 'RootSource_MO1', 'Reactor_MI1') +
          stream('InnerProduct', 'Stream', 'Reactor_MO1', 'RootSink_MI1')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      const parentStart = out.indexOf('<bpmn:subProcess id="bpmn_RC"');
      const sourceEvent = out.indexOf('<bpmn:startEvent id="bpmn_RootSource"');
      const sinkEvent = out.indexOf('<bpmn:endEvent id="bpmn_RootSink"');
      const parentEnd = out.indexOf('</bpmn:subProcess>', parentStart);

      expect(sourceEvent).toBeGreaterThan(parentStart);
      expect(sourceEvent).toBeLessThan(parentEnd);
      expect(sinkEvent).toBeGreaterThan(parentStart);
      expect(sinkEvent).toBeLessThan(parentEnd);
      expect(out).toContain('sourcePortRef="RootSource_MO1" targetPortRef="Reactor_MI1"');
      expect(out).toContain('sourcePortRef="Reactor_MO1" targetPortRef="RootSink_MI1"');
    });
  });

  describe('port mapping', () => {
    it('recreates ports as dexpi:port in extensionElements', async () => {
      const ports = port('p1', 'MaterialPort', 'In', 'MI1') + port('p2', 'MaterialPort', 'Out', 'MO1');
      const xml = dexpi(step('T1', 'Pumping', 'Pump', ports));
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expectWellFormedXml(out);
      expect(out).toContain('portType="MaterialPort"');
      expect(out).toContain('direction="Inlet"');
      expect(out).toContain('direction="Outlet"');
    });
  });

  describe('connection mapping', () => {
    it('maps MaterialFlow Stream → bpmn:sequenceFlow', async () => {
      const p1 = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const p2 = port('T1_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', p1) + step('T1', 'Pumping', 'Pump', p2),
        stream('S1', 'Stream', 'SE_out', 'T1_in', 'feed')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:sequenceFlow');
      expect(out).toContain('dexpi:Stream');
    });

    it('maps ThermalEnergyFlow → sequenceFlow with streamType', async () => {
      const p1 = port('src_out', 'ThermalEnergyPort', 'Out', 'TEO1');
      const p2 = port('tgt_in', 'ThermalEnergyPort', 'In', 'TEI1');
      const xml = dexpi(
        step('S1', 'Source', 'Steam', p1) + step('T1', 'ExchangingThermalEnergy', 'HX', p2),
        stream('E1', 'ThermalEnergyFlow', 'src_out', 'tgt_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('streamType="ThermalEnergyFlow"');
    });

    it('synthesises DataObjectReference + associations from canonical MeasuredVariableReference (DEXPI 2.0 schema-correct)', async () => {
      // Schema-correct shape (post-71c1ea0/a32d514): no InformationPort,
      // no InformationFlow. The MeasuringProcessVariable Object carries
      // ProcessStepReference + MeasuredVariableReference; the referenced
      // ProcessStep materialises a QualifiedValue parameter (Components
      // carrier with property="Temperature") that's the reference target.
      const xml = dexpi(`
        <Object id="MA1" type="Process/Process.MeasuringProcessVariable">
          <Data property="Identifier"><String>MA1</String></Data>
          <Data property="Label"><String>TI-101</String></Data>
          <References property="ProcessStepReference" objects="#PS1"/>
          <References property="MeasuredVariableReference" objects="#PS1_Temperature"/>
        </Object>
        <Object id="PS1" type="Process/Process.ReactingChemicals">
          <Data property="Identifier"><String>PS1</String></Data>
          <Data property="Label"><String>Reactor</String></Data>
          <Components property="Temperature">
            <Object id="PS1_Temperature" type="Core/QualifiedValue"/>
          </Components>
        </Object>`);
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('<bpmn:dataObjectReference');
      expect(out).toContain('name="Temperature"');
      // Two associations per instrumentation activity: out from activity to
      // dataObject, in from dataObject to referenced ProcessStep.
      expect((out.match(/<bpmn:association/g) || []).length).toBeGreaterThanOrEqual(2);
    });

    it('synthesises DataObjectReference from Profile-extension MeasuredVariableLabel (vocabulary gap fallback)', async () => {
      // Variable identity has no canonical parameter slot on ReactingChemicals
      // (Composition is a class, not a parameter). Export carries the
      // identity as MeasuredVariableLabel; import recovers it via the same
      // dataObject pattern.
      const xml = dexpi(`
        <Object id="MA2" type="Process/Process.MeasuringProcessVariable">
          <Data property="Identifier"><String>MA2</String></Data>
          <Data property="Label"><String>AI-201</String></Data>
          <Data property="MeasuredVariableLabel"><String>Composition</String></Data>
          <References property="ProcessStepReference" objects="#PS2"/>
        </Object>
        <Object id="PS2" type="Process/Process.ReactingChemicals">
          <Data property="Identifier"><String>PS2</String></Data>
          <Data property="Label"><String>Reactor</String></Data>
        </Object>`);
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('<bpmn:dataObjectReference');
      expect(out).toContain('name="Composition"');
      expect((out.match(/<bpmn:association/g) || []).length).toBeGreaterThanOrEqual(2);
    });

    it('maps InformationFlow → bpmn:association + DataObjectReference', async () => {
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
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:association');
      expect(out).toContain('bpmn:dataObjectReference');
      expect(out).toContain('name="Temperature"');
    });
  });

  describe('layout', () => {
    const shapeBounds = (xml: string, bpmnElement: string) => {
      const match = xml.match(new RegExp(`<bpmndi:BPMNShape[^>]*bpmnElement="${bpmnElement}"[\\s\\S]*?<dc:Bounds x="(-?\\d+(?:\\.\\d+)?)" y="(-?\\d+(?:\\.\\d+)?)" width="(-?\\d+(?:\\.\\d+)?)" height="(-?\\d+(?:\\.\\d+)?)"`));
      if (!match) throw new Error(`No bounds for ${bpmnElement}`);
      return { x: Number(match[1]), y: Number(match[2]), w: Number(match[3]), h: Number(match[4]) };
    };

    const edgeWaypoints = (xml: string, bpmnElement: string) => {
      const edge = xml.match(new RegExp(`<bpmndi:BPMNEdge[^>]*bpmnElement="${bpmnElement}"[\\s\\S]*?</bpmndi:BPMNEdge>`))?.[0] || '';
      return [...edge.matchAll(/<di:waypoint x="(-?\d+(?:\.\d+)?)" y="(-?\d+(?:\.\d+)?)"\/>/g)]
        .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    };

    it('assigns distinct x/y positions to all elements', async () => {
      const p1 = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const p2 = port('T1_in', 'MaterialPort', 'In', 'MI1');
      const p3 = port('T1_out', 'MaterialPort', 'Out', 'MO1');
      const p4 = port('EE_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', p1) + step('T1', 'Pumping', 'Pump', p2 + p3) + step('EE1', 'Sink', 'Out', p4),
        stream('S1', 'Stream', 'SE_out', 'T1_in') + stream('S2', 'Stream', 'T1_out', 'EE_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      // Extract all dc:Bounds x values — should have multiple distinct values
      const bounds = [...out.matchAll(/dc:Bounds x="(\d+)"/g)].map(m => Number(m[1]));
      const unique = new Set(bounds);
      expect(unique.size).toBeGreaterThan(1);
      // Source should be leftmost
      expect(Math.min(...bounds)).toBeGreaterThanOrEqual(100);
    });

    it('keeps source-adjacent tasks left of sink-adjacent tasks', async () => {
      const sourcePort = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const firstPorts = port('A_in', 'MaterialPort', 'In', 'MI1') + port('A_out', 'MaterialPort', 'Out', 'MO1');
      const middlePorts = port('B_in', 'MaterialPort', 'In', 'MI1') + port('B_out', 'MaterialPort', 'Out', 'MO1');
      const lastPorts = port('C_in', 'MaterialPort', 'In', 'MI1') + port('C_out', 'MaterialPort', 'Out', 'MO1');
      const sinkPort = port('EE_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', sourcePort) +
          step('A', 'ReactingChemicals', 'A', firstPorts) +
          step('B', 'Separating', 'B', middlePorts) +
          step('C', 'Compressing', 'C', lastPorts) +
          step('EE1', 'Sink', 'Product', sinkPort),
        stream('S1', 'Stream', 'SE_out', 'A_in') +
          stream('S2', 'Stream', 'A_out', 'B_in') +
          stream('S3', 'Stream', 'B_out', 'C_in') +
          stream('S4', 'Stream', 'C_out', 'EE_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      expect(shapeBounds(out, 'bpmn_A').x).toBeLessThan(shapeBounds(out, 'bpmn_C').x);
      expect(shapeBounds(out, 'bpmn_C').x).toBeLessThan(shapeBounds(out, 'bpmn_EE1').x);
    });

    it('routes sequence flows with orthogonal waypoints', async () => {
      const p1 = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const p2 = port('T1_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', p1) + step('T1', 'Pumping', 'Pump', p2),
        stream('S1', 'Stream', 'SE_out', 'T1_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const waypoints = edgeWaypoints(out, 'bpmn_S1');

      expect(waypoints.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < waypoints.length; i += 1) {
        const prev = waypoints[i - 1];
        const cur = waypoints[i];
        expect(prev.x === cur.x || prev.y === cur.y).toBe(true);
      }
    });

    it('keeps sequence flows orthogonal after shared-port nudging', async () => {
      const p1 = port('SE1_out', 'MaterialPort', 'Out', 'MO1');
      const p2 = port('SE2_out', 'MaterialPort', 'Out', 'MO1');
      const p3 = port('T1_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed 1', p1) +
          step('SE2', 'Source', 'Feed 2', p2) +
          step('T1', 'Pumping', 'Pump', p3),
        stream('S1', 'Stream', 'SE1_out', 'T1_in') +
          stream('S2', 'Stream', 'SE2_out', 'T1_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      ['bpmn_S1', 'bpmn_S2'].forEach(edgeId => {
        const waypoints = edgeWaypoints(out, edgeId);
        expect(waypoints.length).toBeGreaterThanOrEqual(4);
        for (let i = 1; i < waypoints.length; i += 1) {
          const prev = waypoints[i - 1];
          const cur = waypoints[i];
          expect(prev.x === cur.x || prev.y === cur.y).toBe(true);
        }
      });
    });

    it('keeps shared-port sequence-flow endpoints docked to the task border', async () => {
      const sourceSteps = Array.from({ length: 11 }, (_, idx) => {
        const sourceId = `SE${idx + 1}`;
        return step(sourceId, 'Source', `Feed ${idx + 1}`, port(`${sourceId}_out`, 'MaterialPort', 'Out', 'MO1'));
      }).join('');
      const streams = Array.from({ length: 11 }, (_, idx) => {
        const sourceId = `SE${idx + 1}`;
        return stream(`S${idx + 1}`, 'Stream', `${sourceId}_out`, 'T1_in');
      }).join('');
      const xml = dexpi(
        sourceSteps + step('T1', 'Pumping', 'Pump', port('T1_in', 'MaterialPort', 'In', 'MI1')),
        streams
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const target = shapeBounds(out, 'bpmn_T1');

      Array.from({ length: 11 }, (_, idx) => `bpmn_S${idx + 1}`).forEach(edgeId => {
        const waypoints = edgeWaypoints(out, edgeId);
        const last = waypoints.at(-1)!;
        const beforeLast = waypoints.at(-2)!;

        expect(last.x).toBe(target.x);
        expect(last.y).toBeGreaterThanOrEqual(target.y);
        expect(last.y).toBeLessThanOrEqual(target.y + target.h);
        expect(beforeLast.y).toBe(last.y);
      });
    });

    it('orders same-side task ports by their connected neighbor positions', async () => {
      const targetPorts =
        port('T_low', 'MaterialPort', 'In', 'MI3') +
        port('T_high', 'MaterialPort', 'In', 'MI1') +
        port('T_mid', 'MaterialPort', 'In', 'MI2');
      const xml = dexpi(
        step('SE_high', 'Source', 'High feed', port('SE_high_out', 'MaterialPort', 'Out', 'MO1')) +
          step('SE_mid', 'Source', 'Middle feed', port('SE_mid_out', 'MaterialPort', 'Out', 'MO1')) +
          step('SE_low', 'Source', 'Low feed', port('SE_low_out', 'MaterialPort', 'Out', 'MO1')) +
          step('T1', 'ReactingChemicals', 'Reactor', targetPorts),
        stream('S_high', 'Stream', 'SE_high_out', 'T_high') +
          stream('S_mid', 'Stream', 'SE_mid_out', 'T_mid') +
          stream('S_low', 'Stream', 'SE_low_out', 'T_low')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const pairs = [
        { source: shapeBounds(out, 'bpmn_SE_high'), targetY: edgeWaypoints(out, 'bpmn_S_high').at(-1)!.y },
        { source: shapeBounds(out, 'bpmn_SE_mid'), targetY: edgeWaypoints(out, 'bpmn_S_mid').at(-1)!.y },
        { source: shapeBounds(out, 'bpmn_SE_low'), targetY: edgeWaypoints(out, 'bpmn_S_low').at(-1)!.y },
      ].sort((a, b) => (a.source.y + a.source.h / 2) - (b.source.y + b.source.h / 2));

      expect(pairs[0].targetY).toBeLessThan(pairs[1].targetY);
      expect(pairs[1].targetY).toBeLessThan(pairs[2].targetY);
    });

    it('uses stream labels to separate collapsed visual ports on the same DEXPI port ref', async () => {
      const targetPort = port('T_shared', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE_high', 'Source', 'High feed', port('SE_high_out', 'MaterialPort', 'Out', 'MO1')) +
          step('SE_mid', 'Source', 'Middle feed', port('SE_mid_out', 'MaterialPort', 'Out', 'MO1')) +
          step('SE_low', 'Source', 'Low feed', port('SE_low_out', 'MaterialPort', 'Out', 'MO1')) +
          step('T1', 'ReactingChemicals', 'Reactor', targetPort),
        stream('S_high', 'Stream', 'SE_high_out', 'T_shared', 'MO1 - Stream 1 - MI1') +
          stream('S_mid', 'Stream', 'SE_mid_out', 'T_shared', 'MO1 - Stream 2 - MI2') +
          stream('S_low', 'Stream', 'SE_low_out', 'T_shared', 'MO1 - Stream 3 - MI3')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const pairs = [
        { source: shapeBounds(out, 'bpmn_SE_high'), targetY: edgeWaypoints(out, 'bpmn_S_high').at(-1)!.y },
        { source: shapeBounds(out, 'bpmn_SE_mid'), targetY: edgeWaypoints(out, 'bpmn_S_mid').at(-1)!.y },
        { source: shapeBounds(out, 'bpmn_SE_low'), targetY: edgeWaypoints(out, 'bpmn_S_low').at(-1)!.y },
      ].sort((a, b) => (a.source.y + a.source.h / 2) - (b.source.y + b.source.h / 2));

      expect(pairs[0].targetY).toBeLessThan(pairs[1].targetY);
      expect(pairs[1].targetY).toBeLessThan(pairs[2].targetY);
    });

    it('places instrumentation below the process and data objects between instrumentation and target', async () => {
      const sourcePort = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const reactorPorts =
        port('Reactor_in', 'MaterialPort', 'In', 'MI1') +
        port('Reactor_info', 'InformationPort', 'In', 'IPI_Temperature');
      const sensorPort = port('Sensor_info', 'InformationPort', 'Out', 'IPO_Temperature');
      const infoStream = `
        <Object id="IF_temp" type="Process/Process.InformationFlow">
          <Data property="Identifier"><String>IF_temp</String></Data>
          <References property="Source" objects="#Sensor_info"/>
          <References property="Target" objects="#Reactor_info"/>
          <Components property="InformationValue">
            <Object type="Process/Process.InformationVariant">
              <Data property="Label"><String>Temperature</String></Data>
            </Object>
          </Components>
        </Object>`;
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', sourcePort) +
          step('Reactor', 'ReactingChemicals', 'Reactor', reactorPorts) +
          step('Sensor', 'MeasuringProcessVariable', 'TI-101', sensorPort),
        stream('S1', 'Stream', 'SE_out', 'Reactor_in') + infoStream
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const reactor = shapeBounds(out, 'bpmn_Reactor');
      const sensor = shapeBounds(out, 'bpmn_Sensor');
      const dataObject = shapeBounds(out, 'dobj_bpmn_Sensor_bpmn_Temperature');
      const associationToReactor = edgeWaypoints(out, 'assocIn_bpmn_IF_temp');

      expect(sensor.y).toBeGreaterThan(reactor.y + reactor.h);
      expect(dataObject.y).toBeGreaterThan(reactor.y);
      expect(dataObject.y).toBeLessThan(sensor.y + sensor.h);
      expect(associationToReactor[0].y).toBe(dataObject.y);
      expect(associationToReactor.at(-1)?.y).toBe(reactor.y + reactor.h);
      expect(out).toContain('id="assocInfo_bpmn_IF_temp"');
      expect(out).not.toContain('dobj_bpmn_IF_temp');
    });

    it('places recycle loop activities above the main path between the connected layers', async () => {
      const sourcePort = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const reactorPorts =
        port('Reactor_in', 'MaterialPort', 'In', 'MI1') +
        port('Reactor_out', 'MaterialPort', 'Out', 'MO1') +
        port('Reactor_recycle_in', 'MaterialPort', 'In', 'MI2');
      const coolerPorts = port('Cooler_in', 'MaterialPort', 'In', 'MI1') + port('Cooler_out', 'MaterialPort', 'Out', 'MO1');
      const separatorPorts = port('Separator_in', 'MaterialPort', 'In', 'MI1') + port('Separator_out', 'MaterialPort', 'Out', 'MO1');
      const recyclePorts = port('Recycle_in', 'MaterialPort', 'In', 'MI1') + port('Recycle_out', 'MaterialPort', 'Out', 'MO1');
      const sinkPort = port('EE_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', sourcePort) +
          step('Reactor', 'ReactingChemicals', 'Reactor', reactorPorts) +
          step('Cooler', 'RemovingThermalEnergy', 'Cooler', coolerPorts) +
          step('Separator', 'Separating', 'Separator', separatorPorts) +
          step('Recycle', 'Compressing', 'Recycle compressor', recyclePorts) +
          step('EE1', 'Sink', 'Product', sinkPort),
        stream('S1', 'Stream', 'SE_out', 'Reactor_in') +
          stream('S2', 'Stream', 'Reactor_out', 'Cooler_in') +
          stream('S3', 'Stream', 'Cooler_out', 'Separator_in') +
          stream('S4', 'Stream', 'Separator_out', 'Recycle_in') +
          stream('S5', 'Stream', 'Recycle_out', 'Reactor_recycle_in') +
          stream('S6', 'Stream', 'Separator_out', 'EE_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const reactor = shapeBounds(out, 'bpmn_Reactor');
      const separator = shapeBounds(out, 'bpmn_Separator');
      const recycle = shapeBounds(out, 'bpmn_Recycle');
      const cooler = shapeBounds(out, 'bpmn_Cooler');

      expect(recycle.x).toBeGreaterThan(reactor.x);
      expect(recycle.x).toBeLessThan(separator.x);
      expect(recycle.y).toBeLessThan(cooler.y);

      const recycleIncoming = edgeWaypoints(out, 'bpmn_S4');
      const recycleOutgoing = edgeWaypoints(out, 'bpmn_S5');
      expect(recycleIncoming.at(-1)?.x).toBe(recycle.x + recycle.w);
      expect(recycleIncoming.at(-1)?.y).toBe(recycle.y + recycle.h * 0.65);
      expect(Math.min(...recycleIncoming.map(point => point.y))).toBeGreaterThanOrEqual(recycle.y);
      expect(recycleOutgoing[0].x).toBe(recycle.x);
      expect(recycleOutgoing[0].y).toBe(recycle.y + recycle.h * 0.35);
      expect(recycleOutgoing[1].x).toBeLessThan(recycleOutgoing[0].x);
      expect(Math.min(...recycleOutgoing.map(point => point.y))).toBeGreaterThanOrEqual(Math.min(recycle.y, reactor.y));
      expect(out).toMatch(/portId="Recycle_in"[^>]*direction="Inlet"[^>]*anchorSide="right"[^>]*anchorOffset="0.65"/);
      expect(out).toMatch(/portId="Recycle_out"[^>]*direction="Outlet"[^>]*anchorSide="left"[^>]*anchorOffset="0.35"/);
    });

    it('routes backward right-to-left recycle returns through a local side corridor', async () => {
      const sourcePort = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const reactorPorts =
        port('Reactor_in', 'MaterialPort', 'In', 'MI1') +
        port('Reactor_out', 'MaterialPort', 'Out', 'MO1') +
        port('Reactor_recycle_in', 'MaterialPort', 'In', 'MI2');
      const branchPorts = port('Branch_in', 'MaterialPort', 'In', 'MI1') + port('Branch_out', 'MaterialPort', 'Out', 'MO1');
      const sinkPort = port('EE_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', sourcePort) +
          step('Reactor', 'ReactingChemicals', 'Reactor', reactorPorts) +
          step('Branch', 'StrippingDistilling', 'Recycle branch', branchPorts) +
          step('EE1', 'Sink', 'Product', sinkPort),
        stream('S1', 'Stream', 'SE_out', 'Reactor_in') +
          stream('S2', 'Stream', 'Reactor_out', 'Branch_in') +
          stream('S3', 'Stream', 'Branch_out', 'Reactor_recycle_in') +
          stream('S4', 'Stream', 'Branch_out', 'EE_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const reactor = shapeBounds(out, 'bpmn_Reactor');
      const branch = shapeBounds(out, 'bpmn_Branch');
      const recycleReturn = edgeWaypoints(out, 'bpmn_S3');

      expect(recycleReturn[0].x).toBe(branch.x + branch.w);
      expect(recycleReturn.at(-1)?.x).toBe(reactor.x);
      expect(Math.min(...recycleReturn.map(point => point.y))).toBeGreaterThanOrEqual(Math.min(reactor.y, branch.y));
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
      const bpmn2 = await new DexpiToBpmnTransformer().transform(dexpiXml);

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
