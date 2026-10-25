import { describe, it, expect } from 'vitest';
import { DexpiToBpmnTransformer, DexpiImportError } from '../DexpiToBpmnTransformer';
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

  // The importer reads DEXPI Process documents only. Anything else is
  // classified so the UI can say what the file is instead of a bare
  // "not found": a P&ID (Plant model or Proteus XML), a non-DEXPI file, or a
  // DEXPI Model with no ProcessModel.
  describe('document classification', () => {
    async function importError(xml: string): Promise<DexpiImportError> {
      try {
        await new DexpiToBpmnTransformer().transform(xml);
      } catch (err) {
        expect(err).toBeInstanceOf(DexpiImportError);
        return err as DexpiImportError;
      }
      throw new Error('expected transform() to throw');
    }

    it('classifies a DEXPI 2.0 Plant model (P&ID) as plant', async () => {
      const err = await importError(`<?xml version="1.0" encoding="UTF-8"?>
<Model name="reference_pid" uri="http://www.example.org/pid">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Plant" source="https://data.dexpi.org/models/2.0.0/Plant.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="plant1" type="Plant/PlantModel">
        <Components property="Equipment">
          <Object id="P4712" type="Plant/CentrifugalPump"/>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`);
      expect(err.kind).toBe('plant');
      expect(err.message).toContain('DEXPI Plant model');
      expect(err.message).toContain('P&ID');
      expect(err.detail).toContain('Plant/PlantModel');
    });

    it('classifies a Plant model by its Plant.xml import alone', async () => {
      const err = await importError(`<Model name="pid" uri="http://www.example.org/pid">
  <Import prefix="Plant" source="https://data.dexpi.org/models/2.0.0/Plant.xml"/>
  <Object type="Core/EngineeringModel"/>
</Model>`);
      expect(err.kind).toBe('plant');
      expect(err.detail).toContain('Plant.xml');
    });

    it('classifies a Proteus XML P&ID (DEXPI 1.x) as proteus', async () => {
      const err = await importError(`<?xml version="1.0" encoding="UTF-8"?>
<PlantModel>
  <PlantInformation SchemaVersion="4.1" OriginatingSystem="Example" Discipline="PID" Units="mm" Is3D="no"/>
  <Drawing Name="Sheet1" Type="PID"/>
  <Equipment ID="P4712" ComponentClass="CentrifugalPump"/>
</PlantModel>`);
      expect(err.kind).toBe('proteus');
      expect(err.message).toContain('Proteus XML');
      expect(err.message).toContain('DEXPI 1.x');
      expect(err.detail).toContain('<PlantModel>');
      expect(err.detail).toContain('Discipline="PID"');
    });

    it('classifies a BPMN diagram as not-dexpi', async () => {
      const err = await importError(`<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">
  <bpmn:process id="Process_1" isExecutable="false"/>
</bpmn:definitions>`);
      expect(err.kind).toBe('not-dexpi');
      expect(err.message).toContain('not a DEXPI document');
      expect(err.detail).toContain('BPMN');
    });

    it('classifies a Process Model without a ProcessModel object as no-process-model', async () => {
      const err = await importError(`<Model name="empty" uri="http://www.example.org/empty">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel"/>
  </Object>
</Model>`);
      expect(err.kind).toBe('no-process-model');
      expect(err.message).toContain('No ProcessModel found');
      expect(err.detail).toContain('Process.xml');
    });

    it('still imports a document that holds a ProcessModel next to a Plant import', async () => {
      const xml = dexpi(step('SE1', 'Source', 'Feed')).replace(
        '<Import prefix="Process"',
        '<Import prefix="Plant" source="https://data.dexpi.org/models/2.0.0/Plant.xml"/>\n  <Import prefix="Process"',
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expect(out).toContain('bpmn:startEvent');
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

      expect(out).toContain('<bpmn:startEvent id="ReactantA"');
      expect(out).toContain('<bpmn:sequenceFlow id="RealFeed"');
      expect(out).not.toContain('id="MI1Proxy"');
      expect(out).not.toContain('id="MO1Proxy"');
      expect(out).not.toContain('id="ProxyFeed"');
      expect(out).not.toContain('id="ProxyOut"');
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

      const parentStart = out.indexOf('<bpmn:subProcess id="RC1"');
      const childTask = out.indexOf('<bpmn:task id="MX1"');
      const parentEnd = out.indexOf('</bpmn:subProcess>', parentStart);

      expect(parentStart).toBeGreaterThan(-1);
      expect(out).toContain('isExpanded="false"');
      expect(childTask).toBeGreaterThan(parentStart);
      expect(childTask).toBeLessThan(parentEnd);
      expect(out).toContain('<bpmndi:BPMNPlane id="RC1_plane" bpmnElement="RC1">');
      expect(out).toContain('id="MX1_di"');
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

      const parentStart = out.indexOf('<bpmn:subProcess id="RC1"');
      const internalFlow = out.indexOf('<bpmn:sequenceFlow id="S_internal"');
      const parentEnd = out.indexOf('</bpmn:subProcess>', parentStart);

      expect(internalFlow).toBeGreaterThan(parentStart);
      expect(internalFlow).toBeLessThan(parentEnd);
      expect(out).toContain('id="S_internal_di"');
      expect(out).toContain('<bpmn:outgoing>S_internal</bpmn:outgoing>');
      expect(out).toContain('<bpmn:incoming>S_internal</bpmn:incoming>');
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

      const subprocessEnd = out.indexOf('</bpmn:subProcess>', out.indexOf('<bpmn:subProcess id="RC1"'));
      const dataObject = out.indexOf('name="Temperature"');
      const subprocessPlane = out.indexOf('<bpmndi:BPMNPlane id="RC1_plane"');
      const dataObjectShape = out.indexOf('bpmnElement="dobj_Sensor_Temperature"');

      expect(dataObject).toBeGreaterThan(-1);
      expect(dataObject).toBeLessThan(subprocessEnd);
      expect(dataObjectShape).toBeGreaterThan(subprocessPlane);
    });

    it('imports instrumentation from the canonical InstrumentationSystemActivities container and seats it beside the observed step', async () => {
      // DEXPI 2.0 (Process.xml): ProcessStep.SubProcessSteps takes
      // /Process.ProcessStep only, and InstrumentationActivity descends from
      // Core/ConceptualObject — so a schema-correct document carries its
      // MeasuringProcessVariable / ControllingProcessVariable objects under
      //   ProcessModel.InstrumentationSystemActivities
      //     └── InstrumentationSystemActivity.InstrumentationActivities
      // and links each back to its step with ProcessStepReference. This is
      // the shape the exporter emits since the issue-#87 fix; the importer
      // must read it (it used to look only inside SubProcessSteps, so every
      // instrument in a canonical document was silently dropped).
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="process_model" uri="http://www.example.org">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="pm1" type="Process/ProcessModel">
        <Components property="ProcessSteps">
${subProcessStep('RC1', 'ReactingChemicals', 'Reactor section', `
        <Object id="PS1" type="Process/Process.ReactingChemicals">
          <Data property="Identifier"><String>PS1</String></Data>
          <Data property="Label"><String>Reactor</String></Data>
          <Components property="Temperature">
            <Object id="PS1_Temperature" type="Core/QualifiedValue"/>
          </Components>
        </Object>`)}
${step('PU1', 'Pumping', 'Feed pump')}
        </Components>
        <Components property="InstrumentationSystemActivities">
          <Object id="InstrumentationSystem" type="Process/Process.InstrumentationSystemActivity">
            <Data property="Identifier"><String>Instrumentation</String></Data>
            <Data property="Label"><String>Instrumentation</String></Data>
            <Components property="InstrumentationActivities">
              <Object id="MA1" type="Process/Process.MeasuringProcessVariable">
                <Data property="Identifier"><String>MA1</String></Data>
                <Data property="Label"><String>TI-101</String></Data>
                <References property="ProcessStepReference" objects="#PS1"/>
                <References property="MeasuredVariableReference" objects="#PS1_Temperature"/>
              </Object>
              <Object id="MA2" type="Process/Process.MeasuringProcessVariable">
                <Data property="Identifier"><String>MA2</String></Data>
                <Data property="Label"><String>FI-201</String></Data>
                <References property="ProcessStepReference" objects="#PU1"/>
              </Object>
            </Components>
          </Object>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expectWellFormedXml(out);

      // Both instruments survive the import as tasks.
      expect(out).toContain('<bpmn:task id="MA1"');
      expect(out).toContain('<bpmn:task id="MA2"');
      expect(out).toContain('dexpiType="MeasuringProcessVariable"');

      // MA1 observes PS1, which lives inside subprocess RC1, so MA1 is seated
      // on RC1's plane next to it — where the BPMN author drew it.
      const rcStart = out.indexOf('<bpmn:subProcess id="RC1"');
      const rcEnd = out.indexOf('</bpmn:subProcess>', rcStart);
      const ma1 = out.indexOf('<bpmn:task id="MA1"');
      expect(ma1).toBeGreaterThan(rcStart);
      expect(ma1).toBeLessThan(rcEnd);

      // MA2 observes a root-level step and stays on the root plane.
      const ma2 = out.indexOf('<bpmn:task id="MA2"');
      expect(ma2 < rcStart || ma2 > rcEnd).toBe(true);

      // The measured-variable wiring is reconstructed from the canonical
      // references exactly as for the flat shape.
      expect(out).toContain('<bpmn:dataObjectReference id="PS1_Temperature"');
      expect(out).toContain('<bpmn:dataOutputAssociation id="DataOutputAssociation_PS1_Temperature">');
      expect(out).toContain('<bpmn:dataInputAssociation id="DataInputAssociation_PS1_Temperature">');
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

      expect(out).toContain('<bpmn:subProcess id="RC1"');
      expect(out).toContain('<bpmn:task id="MX1"');
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

      expect(out).toContain('<bpmn:startEvent id="RC_MI1_Source" name="MI1">');
      expect(out).toContain('<bpmn:endEvent id="RC_MO1_Sink" name="MO1">');
      expect(out).toContain('portId="RC_MI1" name="MI1" portType="MaterialPort" direction="Inlet"');
      expect(out).toContain('subReference="RC_MI1_Source_MI1_port"');
      expect(out).toContain('portId="RC_MI1_Source_MI1_port" name="MI1" portType="MaterialPort" direction="Outlet"');
      expect(out).toContain('superReference="RC_MI1"');
      expect(out).toContain('sourcePortRef="RC_MI1_Source_MI1_port" targetPortRef="Reactor_MI1"');
      expect(out).toContain('sourcePortRef="Reactor_MO1" targetPortRef="RC_MO1_Sink_MO1_port"');
      expect(out).not.toContain('id="BoundaryOut"');
      expect(out).not.toContain('RC_TEI1_Source');
      expect(out).not.toContain('RC_IPI_Temperature_Source');
      expect(out).toContain('id="ThermalPeer"');
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

      expect(out).toContain('<bpmn:startEvent id="InnerSource" name="MI1">');
      expect(out).toContain('superReference="RC_MI1"');
      expect(out).toContain('subReference="InnerSource_MO1"');
      expect(out).not.toContain('RC_MI1_Source');
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

      const parentStart = out.indexOf('<bpmn:subProcess id="RC"');
      const sourceEvent = out.indexOf('<bpmn:startEvent id="RootSource"');
      const sinkEvent = out.indexOf('<bpmn:endEvent id="RootSink"');
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
      // The dataObjectReference reuses the MeasuredVariableReference target id
      // (round-trips the original BPMN dataObjectReference id).
      expect(out).toContain('<bpmn:dataObjectReference id="PS1_Temperature"');
      expect(out).toContain('name="Temperature"');
      expect(out).toContain('dataObjectRef="DataObject_PS1_Temperature"');
      // Instrumentation task → dataObject via dataOutputAssociation.
      expect(out).toContain('<bpmn:dataOutputAssociation id="DataOutputAssociation_PS1_Temperature">');
      expect(out).toContain('<bpmn:targetRef>PS1_Temperature</bpmn:targetRef>');
      // Measured task ← dataObject via __targetRef_placeholder + dataInputAssociation.
      expect(out).toContain('name="__targetRef_placeholder"');
      expect(out).toContain('<bpmn:dataInputAssociation id="DataInputAssociation_PS1_Temperature">');
      expect(out).toContain('<bpmn:sourceRef>PS1_Temperature</bpmn:sourceRef>');
      // No generic top-level instrumentation associations remain.
      expect(out).not.toContain('<bpmn:association ');
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
      // No canonical MeasuredVariableReference here, so the dataObjectReference
      // falls back to a synthetic deterministic id, but still uses the same
      // nested dataInput/dataOutputAssociation wiring.
      expect(out).toContain('<bpmn:dataObjectReference');
      expect(out).toContain('name="Composition"');
      expect(out).toContain('<bpmn:dataOutputAssociation');
      expect(out).toContain('<bpmn:dataInputAssociation');
      expect(out).toContain('name="__targetRef_placeholder"');
      // No generic top-level instrumentation associations remain.
      expect(out).not.toContain('<bpmn:association ');
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

      expect(shapeBounds(out, 'A').x).toBeLessThan(shapeBounds(out, 'C').x);
      expect(shapeBounds(out, 'C').x).toBeLessThan(shapeBounds(out, 'EE1').x);
    });

    it('routes sequence flows with orthogonal waypoints', async () => {
      const p1 = port('SE_out', 'MaterialPort', 'Out', 'MO1');
      const p2 = port('T1_in', 'MaterialPort', 'In', 'MI1');
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', p1) + step('T1', 'Pumping', 'Pump', p2),
        stream('S1', 'Stream', 'SE_out', 'T1_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const waypoints = edgeWaypoints(out, 'S1');

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

      ['S1', 'S2'].forEach(edgeId => {
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
      const target = shapeBounds(out, 'T1');

      Array.from({ length: 11 }, (_, idx) => `S${idx + 1}`).forEach(edgeId => {
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
        { source: shapeBounds(out, 'SE_high'), targetY: edgeWaypoints(out, 'S_high').at(-1)!.y },
        { source: shapeBounds(out, 'SE_mid'), targetY: edgeWaypoints(out, 'S_mid').at(-1)!.y },
        { source: shapeBounds(out, 'SE_low'), targetY: edgeWaypoints(out, 'S_low').at(-1)!.y },
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
        { source: shapeBounds(out, 'SE_high'), targetY: edgeWaypoints(out, 'S_high').at(-1)!.y },
        { source: shapeBounds(out, 'SE_mid'), targetY: edgeWaypoints(out, 'S_mid').at(-1)!.y },
        { source: shapeBounds(out, 'SE_low'), targetY: edgeWaypoints(out, 'S_low').at(-1)!.y },
      ].sort((a, b) => (a.source.y + a.source.h / 2) - (b.source.y + b.source.h / 2));

      expect(pairs[0].targetY).toBeLessThan(pairs[1].targetY);
      expect(pairs[1].targetY).toBeLessThan(pairs[2].targetY);
    });

    it('places instrumentation above the process and data objects between instrumentation and target', async () => {
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
      const reactor = shapeBounds(out, 'Reactor');
      const sensor = shapeBounds(out, 'Sensor');
      const dataObject = shapeBounds(out, 'dobj_Sensor_Temperature');
      const associationToReactor = edgeWaypoints(out, 'assocIn_IF_temp');

      // Instrumentation is aligned on a single horizontal band ABOVE the
      // highest process step, with the data object between the two.
      expect(sensor.y + sensor.h).toBeLessThan(reactor.y);
      expect(dataObject.y).toBeGreaterThan(sensor.y + sensor.h);
      expect(dataObject.y).toBeLessThan(reactor.y);
      // The association leaves the data object's bottom and enters the
      // reactor's top edge (instrumentation now sits above).
      expect(associationToReactor[0].y).toBe(dataObject.y + dataObject.h);
      expect(associationToReactor.at(-1)?.y).toBe(reactor.y);
      expect(out).toContain('id="assocInfo_IF_temp"');
      expect(out).not.toContain('dobj_IF_temp');
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
      const reactor = shapeBounds(out, 'Reactor');
      const separator = shapeBounds(out, 'Separator');
      const recycle = shapeBounds(out, 'Recycle');
      const cooler = shapeBounds(out, 'Cooler');

      expect(recycle.x).toBeGreaterThan(reactor.x);
      expect(recycle.x).toBeLessThan(separator.x);
      expect(recycle.y).toBeLessThan(cooler.y);

      const recycleIncoming = edgeWaypoints(out, 'S4');
      const recycleOutgoing = edgeWaypoints(out, 'S5');
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
      const reactor = shapeBounds(out, 'Reactor');
      const branch = shapeBounds(out, 'Branch');
      const recycleReturn = edgeWaypoints(out, 'S3');

      expect(recycleReturn[0].x).toBe(branch.x + branch.w);
      expect(recycleReturn.at(-1)?.x).toBe(reactor.x);
      expect(Math.min(...recycleReturn.map(point => point.y))).toBeGreaterThanOrEqual(Math.min(reactor.y, branch.y));
    });

    // ── Regressions from the 2026-10-24 import layout audit ───────────────
    type Pt = { x: number; y: number };
    type Box = { id: string; x: number; y: number; w: number; h: number };
    const planeShapes = (xml: string, planeId = 'BPMNPlane_imported'): Box[] => {
      const plane = xml.match(new RegExp(`<bpmndi:BPMNPlane id="${planeId}"[\\s\\S]*?</bpmndi:BPMNPlane>`))?.[0] || '';
      return [...plane.matchAll(/<bpmndi:BPMNShape[^>]*bpmnElement="([^"]+)"[^>]*>\s*<dc:Bounds x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"/g)]
        .map(m => ({ id: m[1], x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) }));
    };
    const boxesIntersect = (a: Box, b: Box) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const overlappingPairs = (shapes: Box[]) => {
      const pairs: string[] = [];
      shapes.forEach((a, i) => shapes.slice(i + 1).forEach(b => {
        if (boxesIntersect(a, b)) pairs.push(`${a.id} × ${b.id}`);
      }));
      return pairs;
    };
    // Proper crossing of two axis-aligned segments (shared endpoints don't count).
    const segmentsCross = (a1: Pt, a2: Pt, b1: Pt, b2: Pt) => {
      const aHorizontal = a1.y === a2.y;
      const bHorizontal = b1.y === b2.y;
      if (aHorizontal === bHorizontal) return false;
      const [h1, h2] = aHorizontal ? [a1, a2] : [b1, b2];
      const [v1, v2] = aHorizontal ? [b1, b2] : [a1, a2];
      return v1.x > Math.min(h1.x, h2.x) && v1.x < Math.max(h1.x, h2.x) &&
        h1.y > Math.min(v1.y, v2.y) && h1.y < Math.max(v1.y, v2.y);
    };
    const edgesCross = (p: Pt[], q: Pt[]) =>
      p.some((_, i) => i > 0 && q.some((__, j) => j > 0 && segmentsCross(p[i - 1], p[i], q[j - 1], q[j])));
    const segmentHitsBox = (a: Pt, b: Pt, box: Box) => {
      const minX = Math.min(a.x, b.x); const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y); const maxY = Math.max(a.y, b.y);
      return maxX > box.x && minX < box.x + box.w && maxY > box.y && minY < box.y + box.h;
    };

    it('pushes same-layer boxes from different lanes apart instead of letting them overlap', async () => {
      // Layer 2 holds a three-task lane-1 stack (B1..B3 → D) AND a lane-2
      // sink-adjacent task (C → Sink). The stack is centred on lane 1 and its
      // last member lands on C's lane-2 slot unless the layer is separated.
      const xml = dexpi(
        step('SE', 'Source', 'Feed', port('SE_out', 'MaterialPort', 'Out', 'MO1')) +
          step('A', 'MixingSimple', 'A', port('A_in', 'MaterialPort', 'In', 'MI1') + port('A_out', 'MaterialPort', 'Out', 'MO1')) +
          ['B1', 'B2', 'B3'].map(id =>
            step(id, 'Separating', id, port(`${id}_in`, 'MaterialPort', 'In', 'MI1') + port(`${id}_out`, 'MaterialPort', 'Out', 'MO1'))).join('') +
          step('C', 'Pumping', 'C', port('C_in', 'MaterialPort', 'In', 'MI1') + port('C_out', 'MaterialPort', 'Out', 'MO1')) +
          step('D', 'Compressing', 'D', port('D_in', 'MaterialPort', 'In', 'MI1') + port('D_out', 'MaterialPort', 'Out', 'MO1')) +
          step('EE1', 'Sink', 'Product', port('EE1_in', 'MaterialPort', 'In', 'MI1')) +
          step('EE2', 'Sink', 'Purge', port('EE2_in', 'MaterialPort', 'In', 'MI1')),
        stream('S0', 'Stream', 'SE_out', 'A_in') +
          ['B1', 'B2', 'B3'].map(id => stream(`S_${id}`, 'Stream', 'A_out', `${id}_in`) + stream(`S_${id}_D`, 'Stream', `${id}_out`, 'D_in')).join('') +
          stream('S_C', 'Stream', 'A_out', 'C_in') +
          stream('S_C_sink', 'Stream', 'C_out', 'EE2_in') +
          stream('S_D_sink', 'Stream', 'D_out', 'EE1_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const shapes = planeShapes(out);

      expect(shapes.length).toBeGreaterThanOrEqual(9);
      expect(overlappingPairs(shapes)).toEqual([]);
      // Same column, order kept: the lane-2 task stays below the lane-1 stack.
      expect(shapeBounds(out, 'C').x).toBe(shapeBounds(out, 'B3').x);
      expect(shapeBounds(out, 'C').y).toBeGreaterThanOrEqual(shapeBounds(out, 'B3').y + shapeBounds(out, 'B3').h + 100);
      // Every box keeps a positive position.
      shapes.forEach(shape => expect(shape.y).toBeGreaterThanOrEqual(0));
    });

    it('gives fan-in flows distinct bend columns so their vertical segments neither coincide nor cross', async () => {
      const sources = ['SE1', 'SE2', 'SE3', 'SE4'];
      const xml = dexpi(
        sources.map((id, i) => step(id, 'Source', `Feed ${i + 1}`, port(`${id}_out`, 'MaterialPort', 'Out', 'MO1'))).join('') +
          step('T1', 'ReactingChemicals', 'Reactor',
            sources.map((_, i) => port(`T1_in${i + 1}`, 'MaterialPort', 'In', `MI${i + 1}`)).join('') +
            port('T1_out', 'MaterialPort', 'Out', 'MO1')) +
          step('EE1', 'Sink', 'Product', port('EE1_in', 'MaterialPort', 'In', 'MI1')),
        sources.map((id, i) => stream(`S${i + 1}`, 'Stream', `${id}_out`, `T1_in${i + 1}`)).join('') +
          stream('S_out', 'Stream', 'T1_out', 'EE1_in')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const target = shapeBounds(out, 'T1');
      const routes = sources.map((_, i) => edgeWaypoints(out, `S${i + 1}`));

      routes.forEach(route => {
        // Plain Z route: out of the source, one vertical, into the target.
        expect(route).toHaveLength(4);
        expect(route[1].x).toBe(route[2].x);
        expect(route[3].x).toBe(target.x);
        expect(route[1].x).toBeLessThan(target.x);
      });
      const bendX = routes.map(route => route[1].x);
      const span = routes.map(route => [Math.min(route[1].y, route[2].y), Math.max(route[1].y, route[2].y)]);
      expect(new Set(bendX).size).toBeGreaterThanOrEqual(2);
      routes.forEach((route, i) => routes.forEach((other, j) => {
        if (j <= i) return;
        const verticalsOverlap = span[i][0] < span[j][1] && span[j][0] < span[i][1];
        if (verticalsOverlap) expect(bendX[i], `S${i + 1} and S${j + 1} share a bend column`).not.toBe(bendX[j]);
        expect(edgesCross(route, other), `S${i + 1} crosses S${j + 1}`).toBe(false);
      }));
    });

    it('always gives the MaterialStates container a shape, even without material templates', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="process_model" uri="http://www.example.org">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="pm1" type="Process/ProcessModel">
        <Components property="ProcessSteps">
${step('SE1', 'Source', 'Feed', port('SE_out', 'MaterialPort', 'Out', 'MO1'))}
${step('T1', 'Pumping', 'Pump', port('T1_in', 'MaterialPort', 'In', 'MI1'))}
        </Components>
        <Components property="ProcessConnections">${stream('S1', 'Stream', 'SE_out', 'T1_in')}</Components>
        <Components property="MaterialStates">
          <Object id="ms1" type="Process/Process.MaterialState">
            <Data property="Identifier"><String>ms1</String></Data>
            <Data property="Label"><String>Base Case - Feed</String></Data>
          </Object>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;
      const out = await new DexpiToBpmnTransformer().transform(xml);
      expectWellFormedXml(out);

      expect(out).toContain('<bpmn:dataObjectReference id="dt_dobj_MaterialStates"');
      expect(out).not.toContain('dt_dobj_MaterialTemplates');
      const shapes = planeShapes(out);
      const container = shapes.find(shape => shape.id === 'dt_dobj_MaterialStates');
      expect(container).toBeDefined();
      expect(container!.y).toBeGreaterThanOrEqual(0);
      // Top-right corner of the plane, clear of every other shape.
      expect(container!.x + container!.w).toBeGreaterThanOrEqual(Math.max(...shapes.map(s => s.x + s.w)));
      expect(overlappingPairs(shapes)).toEqual([]);
    });

    it('routes a data input association around a box sitting above the measured step', async () => {
      // A → T2 → R → A puts the recycle task R in T2's column one lane up, so
      // the straight drop from the instrument's data object into T2's top edge
      // would run through R.
      const t2 = `
        <Object id="T2" type="Process/Process.Separating">
          <Data property="Identifier"><String>T2</String></Data>
          <Data property="Label"><String>Separator</String></Data>
          <Components property="Ports">
            ${port('T2_in', 'MaterialPort', 'In', 'MI1')}
            ${port('T2_out', 'MaterialPort', 'Out', 'MO1')}
            ${port('T2_out2', 'MaterialPort', 'Out', 'MO2')}
          </Components>
          <Components property="Temperature">
            <Object id="T2_Temperature" type="Core/QualifiedValue"/>
          </Components>
        </Object>`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="process_model" uri="http://www.example.org">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="pm1" type="Process/ProcessModel">
        <Components property="ProcessSteps">
${step('SE1', 'Source', 'Feed', port('SE_out', 'MaterialPort', 'Out', 'MO1'))}
${step('A', 'MixingSimple', 'Mixer', port('A_in', 'MaterialPort', 'In', 'MI1') + port('A_in2', 'MaterialPort', 'In', 'MI2') + port('A_out', 'MaterialPort', 'Out', 'MO1'))}
${t2}
${step('R', 'Pumping', 'Recycle pump', port('R_in', 'MaterialPort', 'In', 'MI1') + port('R_out', 'MaterialPort', 'Out', 'MO1'))}
${step('EE1', 'Sink', 'Product', port('EE1_in', 'MaterialPort', 'In', 'MI1'))}
        </Components>
        <Components property="ProcessConnections">
${stream('S1', 'Stream', 'SE_out', 'A_in')}
${stream('S2', 'Stream', 'A_out', 'T2_in')}
${stream('S3', 'Stream', 'T2_out', 'R_in')}
${stream('S4', 'Stream', 'R_out', 'A_in2')}
${stream('S5', 'Stream', 'T2_out2', 'EE1_in')}
        </Components>
        <Components property="InstrumentationSystemActivities">
          <Object id="InstrumentationSystem" type="Process/Process.InstrumentationSystemActivity">
            <Data property="Identifier"><String>Instrumentation</String></Data>
            <Data property="Label"><String>Instrumentation</String></Data>
            <Components property="InstrumentationActivities">
              <Object id="MA1" type="Process/Process.MeasuringProcessVariable">
                <Data property="Identifier"><String>MA1</String></Data>
                <Data property="Label"><String>TI-101</String></Data>
                <References property="ProcessStepReference" objects="#T2"/>
                <References property="MeasuredVariableReference" objects="#T2_Temperature"/>
              </Object>
            </Components>
          </Object>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const t2Box = shapeBounds(out, 'T2');
      const rBox = shapeBounds(out, 'R');
      // Precondition for the regression: R really sits in T2's column above it.
      expect(rBox.x).toBe(t2Box.x);
      expect(rBox.y + rBox.h).toBeLessThanOrEqual(t2Box.y);

      const route = edgeWaypoints(out, 'DataInputAssociation_T2_Temperature');
      expect(route.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < route.length; i += 1) {
        expect(route[i - 1].x === route[i].x || route[i - 1].y === route[i].y).toBe(true);
        expect(segmentHitsBox(route[i - 1], route[i], rBox), `segment ${i} runs through R`).toBe(false);
      }
      // Still enters the measured step on its top edge.
      expect(route.at(-1)!.y).toBe(t2Box.y);
      expect(route.at(-1)!.x).toBeGreaterThan(t2Box.x);
      expect(route.at(-1)!.x).toBeLessThan(t2Box.x + t2Box.w);
    });

    it('leaves the sequence-flow name empty when the stream has no Label', async () => {
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', port('SE_out', 'MaterialPort', 'Out', 'MO1')) +
          step('T1', 'Pumping', 'Pump', port('T1_in', 'MaterialPort', 'In', 'MI1') + port('T1_out', 'MaterialPort', 'Out', 'MO1')) +
          step('EE1', 'Sink', 'Product', port('EE1_in', 'MaterialPort', 'In', 'MI1')),
        stream('ProcessConnection_A51176B3A637DA1C9996CCE286816120', 'Stream', 'SE_out', 'T1_in') +
          stream('S2', 'Stream', 'T1_out', 'EE1_in', 'Product stream')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);

      expect(out).toContain('<bpmn:sequenceFlow id="ProcessConnection_A51176B3A637DA1C9996CCE286816120" name="" ');
      expect(out).toContain('<bpmn:sequenceFlow id="S2" name="Product stream" ');
      // The identifier is still carried on the extension element.
      expect(out).toContain('identifier="ProcessConnection_A51176B3A637DA1C9996CCE286816120"');
    });

    it('shifts the plane so an energy proxy above the top lane never gets a negative coordinate', async () => {
      // R is a recycle step (T2 → R → A) and therefore sits in the top lane.
      // Its electrical-energy source is drawn one band above it — above the
      // canvas origin unless the plane is shifted down.
      const xml = dexpi(
        step('SE1', 'Source', 'Feed', port('SE_out', 'MaterialPort', 'Out', 'MO1')) +
          step('EE_SRC', 'Source', 'Electrical Energy', port('EE_SRC_out', 'ElectricalEnergyPort', 'Out', 'EEO1')) +
          step('A', 'MixingSimple', 'Mixer', port('A_in', 'MaterialPort', 'In', 'MI1') + port('A_in2', 'MaterialPort', 'In', 'MI2') + port('A_out', 'MaterialPort', 'Out', 'MO1')) +
          step('T2', 'Separating', 'Separator', port('T2_in', 'MaterialPort', 'In', 'MI1') + port('T2_out', 'MaterialPort', 'Out', 'MO1') + port('T2_out2', 'MaterialPort', 'Out', 'MO2')) +
          step('R', 'Compressing', 'Recycle compressor',
            port('R_in', 'MaterialPort', 'In', 'MI1') + port('R_ee', 'ElectricalEnergyPort', 'In', 'EEI1') + port('R_out', 'MaterialPort', 'Out', 'MO1')) +
          step('EE1', 'Sink', 'Product', port('EE1_in', 'MaterialPort', 'In', 'MI1')),
        stream('S1', 'Stream', 'SE_out', 'A_in') +
          stream('S2', 'Stream', 'A_out', 'T2_in') +
          stream('S3', 'Stream', 'T2_out', 'R_in') +
          stream('S4', 'Stream', 'R_out', 'A_in2') +
          stream('S5', 'Stream', 'T2_out2', 'EE1_in') +
          stream('S_ee', 'ElectricalEnergyFlow', 'EE_SRC_out', 'R_ee')
      );
      const out = await new DexpiToBpmnTransformer().transform(xml);
      const shapes = planeShapes(out);
      const proxy = shapes.find(shape => shape.id === 'EE_SRC');
      const recycle = shapeBounds(out, 'R');

      expect(proxy).toBeDefined();
      // Drawn above the task it feeds (energy source convention) …
      expect(proxy!.y + proxy!.h).toBeLessThan(recycle.y);
      // … but inside the canvas.
      shapes.forEach(shape => {
        expect(shape.x, `${shape.id} x`).toBeGreaterThanOrEqual(0);
        expect(shape.y, `${shape.id} y`).toBeGreaterThanOrEqual(0);
      });
      expect(overlappingPairs(shapes)).toEqual([]);
    });
  });

  describe('step Description → bpmn:documentation', () => {
    // happy-dom has no namespace-aware lookup; the importer always writes
    // the bpmn: prefix, so match on the qualified tag name.
    const parse = (bpmn: string): Document => new DOMParser().parseFromString(bpmn, 'application/xml');
    const elements = (doc: Document, localName: string): Element[] =>
      Array.from(doc.getElementsByTagName(`bpmn:${localName}`));
    const isDocumentation = (c: Element): boolean =>
      c.tagName === 'bpmn:documentation' || c.localName === 'documentation';
    const documentationOf = (el: Element | undefined): Element | null =>
      (el && Array.from(el.children).find(isDocumentation)) || null;

    const multiLanguageDescription = (text: string): string => `
          <Data property="Description">
            <AggregatedDataValue type="Core/DataTypes.MultiLanguageString">
              <Data property="SingleLanguageStrings">
                <AggregatedDataValue type="Core/DataTypes.SingleLanguageString">
                  <Data property="Language"><String>en</String></Data>
                  <Data property="Value"><String>${text}</String></Data>
                </AggregatedDataValue>
              </Data>
            </AggregatedDataValue>
          </Data>`;

    const describedStep = (id: string, type: string, label: string, descriptionXml: string): string => `
        <Object id="${id}" type="Process/Process.${type}">
          <Data property="Identifier"><String>${id}</String></Data>
          <Data property="Label"><String>${label}</String></Data>
          ${descriptionXml}
        </Object>`;

    it('emits the canonical MultiLanguageString Description as <bpmn:documentation> before extensionElements', async () => {
      const xml = dexpi(describedStep('S1', 'Pumping', 'Feed pump',
        multiLanguageDescription('Transfers feed from storage to the reactor')));
      const bpmn = await new DexpiToBpmnTransformer().transform(xml);
      expectWellFormedXml(bpmn);

      const task = elements(parse(bpmn), 'task')[0];
      expect(task).toBeDefined();
      const children = Array.from(task.children).map(c => c.tagName.replace(/^bpmn:/, ''));
      expect(children[0]).toBe('documentation');
      expect(children.indexOf('documentation')).toBeLessThan(children.indexOf('extensionElements'));
      expect(task.children[0].textContent).toBe('Transfers feed from storage to the reactor');
      // Not duplicated into the generic attribute carrier.
      expect(bpmn).not.toContain('<dexpi:data property="Description">');
    });

    it('reads the plain <String> Description form too', async () => {
      const xml = dexpi(describedStep('S1', 'Mixing', 'Mixer',
        '<Data property="Description"><String>Blends A &amp; B</String></Data>'));
      const bpmn = await new DexpiToBpmnTransformer().transform(xml);
      expectWellFormedXml(bpmn);
      expect(documentationOf(elements(parse(bpmn), 'task')[0])?.textContent).toBe('Blends A & B');
    });

    it('carries Description on Source / Sink events and subprocesses as well', async () => {
      const xml = dexpi([
        describedStep('SRC', 'Source', 'Feed', multiLanguageDescription('Raw feed entry')),
        subProcessStep('SP', 'ProcessStep', 'Section', step('C1', 'Pumping', 'Inner pump'))
          .replace('<Data property="Label"><String>Section</String></Data>',
            '<Data property="Label"><String>Section</String></Data>' + multiLanguageDescription('Whole section')),
        describedStep('SNK', 'Sink', 'Product', multiLanguageDescription('Product outlet')),
      ].join('\n'));
      const bpmn = await new DexpiToBpmnTransformer().transform(xml);
      expectWellFormedXml(bpmn);
      const doc = parse(bpmn);
      expect(documentationOf(elements(doc, 'startEvent')[0])?.textContent).toBe('Raw feed entry');
      expect(documentationOf(elements(doc, 'endEvent')[0])?.textContent).toBe('Product outlet');
      expect(documentationOf(elements(doc, 'subProcess')[0])?.textContent).toBe('Whole section');
      // Child without a Description gets no documentation element.
      const inner = elements(doc, 'task').find(t => t.getAttribute('name') === 'Inner pump');
      expect(inner).toBeDefined();
      expect(documentationOf(inner)).toBeNull();
    });

    it('omits <bpmn:documentation> when the step has no Description', async () => {
      const bpmn = await new DexpiToBpmnTransformer().transform(dexpi(step('S1', 'Pumping', 'Pump')));
      expect(bpmn).not.toContain('<bpmn:documentation>');
    });
  });

  describe('round-trip', () => {
    it('BPMN → DEXPI → BPMN keeps bpmn:documentation as ProcessStep.Description', async () => {
      const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:dexpi="http://dexpi.org/bpmn-extension/1.0" id="D1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P1">
    <bpmn:startEvent id="SE1"><bpmn:documentation>Feed enters here</bpmn:documentation><bpmn:extensionElements><dexpi:element dexpiType="Source" identifier="SE1" uid="uid_SE1"/></bpmn:extensionElements><bpmn:outgoing>F1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="T1" name="Pumping"><bpmn:documentation>Pumps feed &amp; recycle</bpmn:documentation><bpmn:extensionElements><dexpi:element dexpiType="Pumping" identifier="T1" uid="uid_T1"><dexpi:port portId="T1_MI1" name="MI1" portType="MaterialPort" direction="Inlet"/><dexpi:port portId="T1_MO1" name="MO1" portType="MaterialPort" direction="Outlet"/></dexpi:element></bpmn:extensionElements><bpmn:incoming>F1</bpmn:incoming><bpmn:outgoing>F2</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="EE1"><bpmn:extensionElements><dexpi:element dexpiType="Sink" identifier="EE1" uid="uid_EE1"/></bpmn:extensionElements><bpmn:incoming>F2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="SE1" targetRef="T1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T1" targetRef="EE1"/>
  </bpmn:process>
</bpmn:definitions>`;

      const dexpiXml = await new BpmnToDexpiTransformer().transform(bpmn);
      expect(dexpiXml).toContain('Pumps feed &amp; recycle');
      const bpmn2 = await new DexpiToBpmnTransformer().transform(dexpiXml);
      expectWellFormedXml(bpmn2);
      const doc = new DOMParser().parseFromString(bpmn2, 'application/xml');
      const docText = (localName: string): string | null => {
        const el = doc.getElementsByTagName(`bpmn:${localName}`)[0];
        const d = el && Array.from(el.children).find(c => c.tagName === 'bpmn:documentation');
        return d ? d.textContent : null;
      };
      expect(docText('task')).toBe('Pumps feed & recycle');
      expect(docText('startEvent')).toBe('Feed enters here');
      expect(docText('endEvent')).toBeNull();
    });

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

describe('ProcessStep.HierarchyLevel import', () => {
  const ref = (literal: string) =>
    `<Data property="HierarchyLevel"><DataReference data="Process/Enumerations.ProcessStepHierarchyLevel.${literal}"/></Data>`;

  it('reads the DataReference literal into dexpi:element hierarchyLevel', async () => {
    const section = `
        <Object id="SEC1" type="Process/Process.ReactingChemicals">
          <Data property="Identifier"><String>SEC1</String></Data>
          <Data property="Label"><String>Section</String></Data>
          ${ref('ProcessSection')}
          <Components property="SubProcessSteps">
            <Object id="MX1" type="Process/Process.Mixing">
              <Data property="Identifier"><String>MX1</String></Data>
              <Data property="Label"><String>Mixer</String></Data>
              ${ref('UnitOperation')}
            </Object>
          </Components>
        </Object>`;
    const out = await new DexpiToBpmnTransformer().transform(dexpi(section));
    expect(out).toMatch(/<dexpi:element dexpiType="ReactingChemicals"[^>]*hierarchyLevel="ProcessSection"/);
    expect(out).toMatch(/<dexpi:element dexpiType="Mixing"[^>]*hierarchyLevel="UnitOperation"/);
    // Not duplicated as a generic attribute.
    expect(out).not.toContain('property="HierarchyLevel"');
  });

  it('omits the attribute when the step carries no HierarchyLevel', async () => {
    const out = await new DexpiToBpmnTransformer().transform(dexpi(step('MX1', 'Mixing', 'Mixer')));
    expect(out).not.toContain('hierarchyLevel=');
  });

  it('round-trips an explicit non-default level through BPMN back to DEXPI', async () => {
    const xml = dexpi(`
        <Object id="MX1" type="Process/Process.Mixing">
          <Data property="Identifier"><String>MX1</String></Data>
          <Data property="Label"><String>Mixer</String></Data>
          ${ref('ControlFunction')}
        </Object>`);
    const bpmn = await new DexpiToBpmnTransformer().transform(xml);
    const back = await new BpmnToDexpiTransformer().transform(bpmn);
    expect(back).toContain('ProcessStepHierarchyLevel.ControlFunction');
    expect(back).not.toContain('ProcessStepHierarchyLevel.UnitOperation');
  });
});

describe('DexpiToBpmnTransformer — a document carrying a P&ID beside the process model', () => {
  // Core allows one conceptual model per EngineeringModel, so a file that holds
  // both a plant and a process model does so as two EngineeringModel objects.
  const MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="mixed" uri="urn:test:mixed">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
  <Import prefix="Plant" source="https://data.dexpi.org/models/2.0.0/Plant.xml"/>
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="plant1" type="Plant/PlantModel">
        <Components property="TaggedPlantItems">
          <Object id="T1" type="Plant/ProcessEquipment.Tank"/>
        </Components>
      </Object>
    </Components>
  </Object>
  <Object type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="pm1" type="Process/ProcessModel">
        <Components property="ProcessSteps">
          <Object id="PU1" type="Process/Process.Pumping">
            <Data property="Identifier"><String>PU1</String></Data>
            <Data property="Label"><String>Feed pump</String></Data>
          </Object>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;

  it('imports the process model and says the P&ID part was not read', async () => {
    const t = new DexpiToBpmnTransformer();
    const out = await t.transform(MIXED);
    expect(out).toContain('<bpmn:task id="PU1"');
    expect(out).not.toContain('Tank');
    expect(t.lastImportNotices).toHaveLength(1);
    expect(t.lastImportNotices[0]).toMatch(/P&ID.*only the process model/);
    expect(t.lastImportCompanion?.kind).toBe('plant');
    expect(t.lastImportCompanion?.detail).toContain('Plant/PlantModel');
  });

  it('records no notice for a plain process document', async () => {
    const t = new DexpiToBpmnTransformer();
    await t.transform(dexpi(step('PU1', 'Pumping', 'Feed pump')));
    expect(t.lastImportNotices).toEqual([]);
    expect(t.lastImportCompanion).toBeUndefined();
  });
});
