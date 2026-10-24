/**
 * Regression tests for the neo4jExporter against the DEXPI 2.0 Process.xml
 * shape the BpmnToDexpiTransformer writes today (probe of 2026-10-24 on a
 * fresh Tennessee Eastman export, main 920a01c, found six gaps):
 *
 *  1. instrumentation under ProcessModel.InstrumentationSystemActivities
 *     was never read (19 activities in, 0 nodes out);
 *  2. flow type came from a port-label regex, but ports carry no Label, so
 *     every connection became MaterialStream;
 *  3. Port SubReference (ObjectReference@object) / SuperReference
 *     (References@objects) were parsed in the wrong encoding, so no
 *     SUB_PROCESS_ENTRY / SUB_PROCESS_EXIT edges and no navigational flags;
 *  4. Components-carried Core/QualifiedValue quantities were never read;
 *  5. Description (MultiLanguageString) came out as its Language ("en");
 *  6. MoleFlow moved to Composition and was not copied onto the state type.
 *
 * The second half pins the same behaviour on the Semantum "flat" shape
 * (DEXPIViewer's TennesseeEastman-vpd-enriched.xml): ports without any
 * Identifier, streams without Label, packed PhysicalQuantityVector Values.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
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

type Counts = { nodes: Record<string, number>; rels: Record<string, number> };

/** Classify every generated statement as a node CREATE or a relationship. */
function countCypher(queries: string[]): Counts {
  const nodes: Record<string, number> = {};
  const rels: Record<string, number> = {};
  for (const q of queries) {
    const n = q.match(/^CREATE \(:([A-Za-z0-9_]+)/);
    if (n) { nodes[n[1]] = (nodes[n[1]] ?? 0) + 1; continue; }
    const r = q.match(/(?:CREATE|MERGE) \([a-z]+\)-\[:([A-Za-z0-9_]+)/);
    if (r) { rels[r[1]] = (rels[r[1]] ?? 0) + 1; continue; }
    throw new Error(`unclassified statement: ${q.slice(0, 80)}`);
  }
  return { nodes, rels };
}

describe('neo4jExporter — DEXPI 2.0 shape on a fresh TEP export', () => {
  let data: DexpiGraphData;
  let queries: string[];
  let counts: Counts;

  beforeAll(async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const dexpiXml = await new BpmnToDexpiTransformer().transform(bpmn);
    data = parseDexpiXml(dexpiXml);
    queries = generateCypherQueries(data, { clearDatabase: false });
    counts = countCypher(queries);
  });

  it('1. reads InstrumentationSystemActivities into InstrumentationActivity nodes with OBSERVES / MEASURES', () => {
    const activities = data.processSteps.filter(s => s.nodeType === 'InstrumentationActivity');
    expect(activities.length).toBe(19);
    expect(counts.nodes.InstrumentationActivity).toBe(19);
    expect(new Set(activities.map(a => a.type))).toEqual(
      new Set(['MeasuringProcessVariable', 'ControllingProcessVariable']));

    const stepIds = new Set(data.processSteps.map(s => s.id));
    for (const a of activities) {
      // ProcessStepReference resolves to a real step; the activity is
      // CONTAINed by it one level below.
      expect(a.processStepRef).toBeTruthy();
      expect(stepIds.has(a.processStepRef!)).toBe(true);
      expect(a.parent).toBe(a.processStepRef);
      const parent = data.processSteps.find(s => s.id === a.parent)!;
      expect(a.hierarchy_level).toBe(parent.hierarchy_level + 1);
      // MeasuredVariableReference resolves to a QualifiedValue carried by a step.
      expect(a.measuredVariableRef).toBeTruthy();
      const owner = data.qualifiedValueOwners.get(a.measuredVariableRef!);
      expect(owner?.ownerKind).toBe('step');
      expect(owner?.property).toBeTruthy();
    }

    expect(counts.rels.OBSERVES).toBe(19);
    expect(counts.rels.MEASURES).toBe(19);
    // 49 step CONTAINS edges before + 19 instrumentation ones.
    expect(counts.rels.CONTAINS).toBe(68);

    const variables = new Set(
      queries.filter(q => q.includes('[:MEASURES'))
        .map(q => q.match(/variable: '([^']+)'/)?.[1]));
    expect(variables).toEqual(new Set([
      'Temperature', 'RotationalFrequency', 'MassFlow', 'Composition', 'Level', 'Pressure', 'Flow', 'Duty',
    ]));
    // Every MEASURES edge targets the step that owns the variable.
    for (const q of queries.filter(q => q.includes('[:MEASURES'))) {
      const qvId = q.match(/qualifiedValueId: '([^']+)'/)![1];
      const target = q.match(/MATCH \(target \{id: '([^']+)'\}\)/)![1];
      expect(data.qualifiedValueOwners.get(qvId)?.ownerId).toBe(target);
    }
  });

  it('2. types the relationship from the connection Object class, not the port label', () => {
    expect(data.streams.length).toBe(61);
    const byType = data.streams.reduce<Record<string, number>>((acc, s) => {
      acc[s.flowType] = (acc[s.flowType] ?? 0) + 1; return acc;
    }, {});
    expect(byType).toEqual({
      MaterialStream: 54,
      ElectricalEnergyFlow: 4,
      ThermalEnergyFlow: 2,
      MechanicalEnergyFlow: 1,
    });
    expect(counts.rels.MaterialStream).toBe(54);
    expect(counts.rels.ElectricalEnergyFlow).toBe(4);
    expect(counts.rels.ThermalEnergyFlow).toBe(2);
    expect(counts.rels.MechanicalEnergyFlow).toBe(1);
  });

  it('3. reads SubReference / SuperReference in the emitted encoding and derives port links', () => {
    const ports = [...data.ports.values()];
    const withSub = ports.filter(p => p.subReference);
    const withSuper = ports.filter(p => p.superReference);
    expect(withSub.length).toBe(20);
    expect(withSuper.length).toBe(20);
    // Both directions agree pairwise.
    for (const parent of withSub) {
      const child = data.ports.get(parent.subReference!);
      expect(child, `child port ${parent.subReference} of ${parent.id}`).toBeTruthy();
      expect(child!.superReference).toBe(parent.id);
    }
    for (const child of withSuper) {
      const parent = data.ports.get(child.superReference!);
      expect(parent, `parent port ${child.superReference} of ${child.id}`).toBeTruthy();
      expect(parent!.subReference).toBe(child.id);
    }

    // Nested boundary proxies (Source/Sink owning a SuperReference port) are
    // navigational; subprocesses owning SubReference ports are not.
    const navigational = data.processSteps.filter(s => s.isNavigational);
    expect(navigational.length).toBe(20);
    for (const s of navigational) {
      expect(['Source', 'Sink']).toContain(s.nodeType);
      expect(s.parent).toBeTruthy();
    }
    for (const parent of withSub) {
      const owner = data.processSteps.find(s => s.id === parent.ownerStepId)!;
      expect(owner.isSubProcess).toBe(true);
      expect(owner.isNavigational).toBe(false);
    }

    // One edge per link, oriented by the parent port direction.
    const inlets = withSub.filter(p => p.direction === 'In').length;
    const outlets = withSub.filter(p => p.direction === 'Out').length;
    expect(inlets + outlets).toBe(20);
    expect(counts.rels.SUB_PROCESS_ENTRY).toBe(inlets);
    expect(counts.rels.SUB_PROCESS_EXIT).toBe(outlets);
    // Energy boundary links keep their energy flow type.
    const electricalLinks = queries.filter(q =>
      q.includes('[:SUB_PROCESS_ENTRY') && q.includes("flowType: 'ElectricalEnergyFlow'"));
    expect(electricalLinks.length).toBe(2);
  });

  it('4. flattens Components-carried QualifiedValues to <property>_value / _unit / _provenance / _range', () => {
    const material = data.streams.filter(s => s.materialStateRef);
    expect(material.length).toBe(11);
    for (const s of material) {
      expect(typeof s.attributes.MassFlow_value).toBe('number');
      expect(s.attributes.MassFlow_unit).toBe('KilogramPerHour');
      expect(typeof s.attributes.Temperature_value).toBe('number');
      expect(s.attributes.Temperature_unit).toBe('DegreeCelsius');
    }
    // The relationship statement carries the flattened quantity.
    const withMassFlow = queries.filter(q => q.includes('[:MaterialStream') && /MassFlow_value: [0-9.]+/.test(q));
    expect(withMassFlow.length).toBe(11);

    // TEP's measured variables on steps are Observed placeholders: the
    // QualifiedValue has Provenance/Range but an <Undefined/> Value, so
    // the exporter writes _provenance / _range and no _value.
    const observed = data.processSteps.filter(s =>
      Object.keys(s.attributes).some(k => k.endsWith('_provenance')));
    expect(observed.length).toBe(11);
    for (const s of observed) {
      const prov = Object.keys(s.attributes).filter(k => k.endsWith('_provenance'));
      for (const k of prov) {
        const prop = k.replace(/_provenance$/, '');
        expect(s.attributes[k]).toBe('Observed');
        expect(s.attributes[`${prop}_range`]).toBe('Nominal');
        expect(s.attributes[`${prop}_value`]).toBeUndefined();
      }
    }

    // HierarchyLevel enum token stays as an attribute next to the numeric level.
    const sections = data.processSteps.filter(s => s.attributes.HierarchyLevel === 'ProcessSection');
    expect(sections.length).toBeGreaterThan(0);
    for (const s of data.processSteps.filter(s => s.nodeType === 'ProcessStep')) {
      expect(['ProcessSection', 'UnitOperation']).toContain(s.attributes.HierarchyLevel);
      expect(typeof s.hierarchy_level).toBe('number');
    }
  });

  it('5. reads MultiLanguageString Description as its Value, not its Language', () => {
    const all = [
      ...data.processSteps, ...data.materialStateTypes, ...data.materialTemplates, ...data.materialComponents,
    ];
    const descriptions = all.map(x => x.attributes.Description).filter(d => d !== undefined);
    expect(descriptions.length).toBeGreaterThan(0);
    expect(descriptions).not.toContain('en');
    const feedType = data.materialStateTypes.find(t => t.label === 'A Feed - Flow Data');
    expect(feedType?.attributes.Description).toBe('Flow data for A Feed');
    const water = data.materialTemplates.find(t => t.label === 'Water');
    expect(water?.attributes.Description).toBe('Material Template for Water');
  });

  it('6. copies Composition scalars (MoleFlow) onto the MaterialStateType node, fractions unchanged', () => {
    expect(data.materialStateTypes.length).toBe(12);
    for (const t of data.materialStateTypes) {
      expect(typeof t.attributes.MoleFlow_value).toBe('number');
      expect(t.attributes.MoleFlow_unit).toBe('KilomolePerSecond');
      expect(t.attributes.Display).toBe('Percent');
    }
    const stateTypeCreates = queries.filter(q => q.startsWith('CREATE (:MaterialStateType'));
    expect(stateTypeCreates.length).toBe(12);
    for (const q of stateTypeCreates) expect(q).toMatch(/MoleFlow_value: [0-9.e-]+/);
    expect(counts.rels.HAS_FRACTION).toBe(88);
  });

  it('totals: 116 nodes / 307 relationships (97 / 230 before the DEXPI 2.0 fix)', () => {
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(counts.nodes)).toBe(116);
    expect(sum(counts.rels)).toBe(307);
  });
});

/**
 * Minimal document in the Semantum "Model Broker" shape: ports without
 * Identifier or Label, streams without Label, Values packed as sibling
 * <Double>s, MoleFlow on the Composition, Description as MultiLanguageString.
 */
const SEMANTUM_SHAPE = `<?xml version="1.0" encoding="UTF-8"?>
<Model name="ModelBrokerDexpi" uri="http://www.example.org/ModelBrokerDexpi">
  <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml" />
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml" />
  <Object id="EngineeringModel1" type="Core/EngineeringModel">
    <Components property="ConceptualModel">
      <Object id="ProcessModel1" type="Process/ProcessModel">
        <Components property="Compositions">
          <Object id="Composition1" type="Process/Process.Composition">
            <Components property="MoleFractiona">
              <Object id="QualifiedValue1" type="Core/QualifiedValue">
                <Data property="Value">
                  <AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantityVector">
                    <Data property="Values">
                      <Double>0.75</Double>
                      <Double>0.25</Double>
                    </Data>
                    <Data property="Unit">
                      <DataReference data="Core/PhysicalQuantities.PercentageUnit.Percent" />
                    </Data>
                  </AggregatedDataValue>
                </Data>
              </Object>
            </Components>
            <Components property="MoleFlow">
              <Object id="QualifiedValue2" type="Core/QualifiedValue">
                <Data property="Value">
                  <AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">
                    <Data property="Value"><Double>11.2</Double></Data>
                    <Data property="Unit">
                      <DataReference data="Core/PhysicalQuantities.MoleFlowRateUnit.KilomolePerSecond" />
                    </Data>
                  </AggregatedDataValue>
                </Data>
              </Object>
            </Components>
          </Object>
        </Components>
        <Components property="MaterialStates">
          <Object id="MaterialState1" type="Process/Process.MaterialState">
            <References objects="#MaterialStateType1" property="State" />
          </Object>
        </Components>
        <Components property="MaterialStateTypes">
          <Object id="MaterialStateType1" type="Process/Process.MaterialStateType">
            <References objects="#Composition1" property="Composition" />
          </Object>
        </Components>
        <Components property="ProcessSteps">
          <Object id="Step_Source" type="Process/Process.Source">
            <Data property="Description">
              <AggregatedDataValue type="Core/DataTypes.MultiLanguageString">
                <Data property="SingleLanguageStrings">
                  <AggregatedDataValue type="Core/DataTypes.SingleLanguageString">
                    <Data property="Language"><String>en</String></Data>
                    <Data property="Value"><String>D</String></Data>
                  </AggregatedDataValue>
                </Data>
              </AggregatedDataValue>
            </Data>
            <Components property="Ports">
              <Object id="Port_S_out" type="Process/Process.MaterialPort">
                <Data property="NominalDirection">
                  <DataReference data="Process/Enumerations.PortDirection.Outlet" />
                </Data>
                <References objects="#Conn_1" property="ConnectorReference" />
              </Object>
            </Components>
          </Object>
          <Object id="Step_Sep" type="Process/Process.Separating">
            <Data property="Description">
              <AggregatedDataValue type="Core/DataTypes.MultiLanguageString">
                <Data property="SingleLanguageStrings">
                  <AggregatedDataValue type="Core/DataTypes.SingleLanguageString">
                    <Data property="Language"><String>en</String></Data>
                    <Data property="Value"><String>Vapour/liquid separator</String></Data>
                  </AggregatedDataValue>
                </Data>
              </AggregatedDataValue>
            </Data>
            <Components property="Ports">
              <Object id="Port_Sep_in" type="Process/Process.MaterialPort">
                <Data property="NominalDirection">
                  <DataReference data="Process/Enumerations.PortDirection.Inlet" />
                </Data>
                <References objects="#Conn_1" property="ConnectorReference" />
              </Object>
              <Object id="Port_Sep_mech" type="Process/Process.MechanicalEnergyPort">
                <Data property="NominalDirection">
                  <DataReference data="Process/Enumerations.PortDirection.Inlet" />
                </Data>
                <References objects="#Conn_2" property="ConnectorReference" />
              </Object>
            </Components>
            <Components property="Temperature">
              <Object id="QualifiedValue3" type="Core/QualifiedValue">
                <Data property="Value">
                  <AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">
                    <Data property="Value"><Double>80.1</Double></Data>
                    <Data property="Unit">
                      <DataReference data="Core/PhysicalQuantities.TemperatureUnit.DegreeCelsius" />
                    </Data>
                  </AggregatedDataValue>
                </Data>
              </Object>
            </Components>
          </Object>
          <Object id="Step_Motor" type="Process/Process.DrivingByMotor">
            <Components property="Ports">
              <Object id="Port_Motor_out" type="Process/Process.MechanicalEnergyPort">
                <Data property="NominalDirection">
                  <DataReference data="Process/Enumerations.PortDirection.Outlet" />
                </Data>
                <References objects="#Conn_2" property="ConnectorReference" />
              </Object>
            </Components>
          </Object>
        </Components>
        <Components property="ProcessConnections">
          <Object id="Conn_1" type="Process/Process.Stream">
            <References objects="#Port_S_out" property="Source" />
            <References objects="#Port_Sep_in" property="Target" />
            <References objects="#MaterialState1" property="MaterialStateReference" />
            <Data property="Identifier"><String>13</String></Data>
            <Components property="VolumeFlow">
              <Object id="QualifiedValue4" type="Core/QualifiedValue">
                <Data property="Value">
                  <AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">
                    <Data property="Value"><Double>49.37</Double></Data>
                    <Data property="Unit">
                      <DataReference data="Core/PhysicalQuantities.VolumeFlowRateUnit.MetreCubedPerHour" />
                    </Data>
                  </AggregatedDataValue>
                </Data>
              </Object>
            </Components>
          </Object>
          <Object id="Conn_2" type="Process/Process.MechanicalEnergyFlow">
            <References objects="#Port_Motor_out" property="Source" />
            <References objects="#Port_Sep_mech" property="Target" />
          </Object>
        </Components>
      </Object>
    </Components>
  </Object>
</Model>`;

describe('neo4jExporter — Semantum flat shape (ports without Identifier)', () => {
  it('types flows from the connection class when every port label is empty', () => {
    const data = parseDexpiXml(SEMANTUM_SHAPE);
    const queries = generateCypherQueries(data, { clearDatabase: false });
    const counts = countCypher(queries);

    const ports = [...data.ports.values()];
    expect(ports.length).toBe(4);
    expect(ports.every(p => p.label === '')).toBe(true);
    expect(data.streams.map(s => s.flowType).sort()).toEqual(['MaterialStream', 'MechanicalEnergyFlow']);
    expect(counts.rels.MaterialStream).toBe(1);
    expect(counts.rels.MechanicalEnergyFlow).toBe(1);
    expect(counts.nodes).toEqual({ MaterialStateType: 1, MaterialState: 1, Source: 1, ProcessStep: 2 });

    // Quantities on a stream and on a step.
    const stream = data.streams.find(s => s.identifier === '13')!;
    expect(stream.attributes.VolumeFlow_value).toBe(49.37);
    expect(stream.attributes.VolumeFlow_unit).toBe('MetreCubedPerHour');
    const sep = data.processSteps.find(s => s.id === 'Step_Sep')!;
    expect(sep.attributes.Temperature_value).toBe(80.1);
    expect(sep.attributes.Temperature_unit).toBe('DegreeCelsius');
    expect(sep.attributes.Description).toBe('Vapour/liquid separator');
    expect(data.processSteps.find(s => s.id === 'Step_Source')!.attributes.Description).toBe('D');

    // MoleFlow from the Composition lands on the state type; the packed
    // Values vector is read in full (no template → no fractions emitted).
    const stateType = data.materialStateTypes[0];
    expect(stateType.attributes.MoleFlow_value).toBe(11.2);
    expect(stateType.attributes.MoleFlow_unit).toBe('KilomolePerSecond');
    expect(stateType.attributes.MoleFractiona_value).toBeUndefined();
    expect(stateType.fractions).toEqual([]);
    expect(data.qualifiedValueOwners.get('QualifiedValue3')).toEqual({ ownerId: 'Step_Sep', ownerKind: 'step', property: 'Temperature' });
    expect(data.qualifiedValueOwners.get('QualifiedValue4')).toEqual({ ownerId: 'Conn_1', ownerKind: 'stream', property: 'VolumeFlow' });
  });

  // The full DEXPIViewer fixture is not vendored (1.2 MB, third-party).
  // Point SEMANTUM_TE_XML at a local copy of
  // "DEXPI Process Examples/TennesseeEastman-vpd-enriched.xml" to run this.
  const semantumPath = process.env.SEMANTUM_TE_XML;
  it.skipIf(!semantumPath || !existsSync(semantumPath))('full DEXPIViewer TE export: 42 nodes / 44 relationships, 1 MechanicalEnergyFlow', () => {
    const data = parseDexpiXml(readFileSync(semantumPath!, 'utf-8'));
    const counts = countCypher(generateCypherQueries(data, { clearDatabase: false }));
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(counts.nodes)).toBe(42);
    expect(sum(counts.rels)).toBe(44);
    expect(counts.rels).toEqual({ HAS_TYPE: 1, MaterialStream: 42, MechanicalEnergyFlow: 1 });
    expect([...data.ports.values()].filter(p => !p.label).length).toBe(86);
    expect(data.streams.filter(s => Object.keys(s.attributes).some(k => k.endsWith('_value'))).length).toBe(13);
    expect(data.processSteps.filter(s => Object.keys(s.attributes).some(k => k.endsWith('_value'))).length).toBe(4);
    expect(data.processSteps.map(s => s.attributes.Description).filter(Boolean)).not.toContain('en');
    expect(data.materialStateTypes[0].attributes.MoleFlow_unit).toBe('KilomolePerSecond');
  });
});
