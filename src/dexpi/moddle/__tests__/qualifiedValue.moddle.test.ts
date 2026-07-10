/**
 * De-risk the canonical nested QualifiedValue serialisation through the real
 * bpmn-moddle pipeline (the same one bpmn-js uses on saveXML):
 *
 *   1. The dexpi moddle descriptor can build a `<dexpi:data property="Value">`
 *      wrapping a `<dexpi:aggregatedDataValue type="…PhysicalQuantity(Vector)">`
 *      and serialise it to the canonical nested XML.
 *   2. That XML parses back into the same nested moddle shape (round-trip).
 *   3. The shared readCanonicalScalar / readCanonicalVector helpers read the
 *      authored value + unit out of the parsed moddle objects.
 *   4. The transformer consumes the emitted BPMN unchanged (readQvScalar /
 *      composition reader), proving the panel write shape and the transformer
 *      read shape agree.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';
import BpmnModdle from 'bpmn-moddle';

import dexpiDescriptor from '../dexpi.json';
import {
  buildCanonicalScalarValue,
  buildCanonicalVectorValue,
  readCanonicalScalar,
  readCanonicalVector,
  type ModdleFactory,
  type ModdleElement,
} from '../qualifiedValue';

const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

import { BpmnToDexpiTransformer } from '../../../transformer/BpmnToDexpiTransformer';

const SCHEMA_DIR = join(__dirname, '../../../../dexpi-schema-files');
const PROCESS_XML = readFileSync(join(SCHEMA_DIR, 'Process.xml'), 'utf-8');
const CORE_XML = readFileSync(join(SCHEMA_DIR, 'Core.xml'), 'utf-8');

describe('canonical nested QualifiedValue — bpmn-moddle round-trip', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let moddle: any;
  beforeAll(() => {
    moddle = new BpmnModdle({ dexpi: dexpiDescriptor });
  });

  const componentsCarrier = (property: string, valueChild: ModdleElement) =>
    moddle.create('dexpi:Components', {
      property,
      objects: [moddle.create('dexpi:Object', { type: 'Core/QualifiedValue', data: [valueChild] })],
    });

  const serialise = async (carriers: ModdleElement[]): Promise<string> => {
    const defs = moddle.create('bpmn:Definitions', { targetNamespace: 'urn:t' });
    const proc = moddle.create('bpmn:Process', { id: 'P1' });
    const taskA = moddle.create('bpmn:Task', { id: 'A' });
    const taskB = moddle.create('bpmn:Task', { id: 'B' });
    const flow = moddle.create('bpmn:SequenceFlow', { id: 'F1', sourceRef: taskA, targetRef: taskB });
    const ext = moddle.create('bpmn:ExtensionElements');
    const stream = moddle.create('dexpi:Stream', { components: carriers });
    ext.values = [stream];
    flow.extensionElements = ext;
    proc.flowElements = [taskA, taskB, flow];
    defs.rootElements = [proc];
    const { xml } = await moddle.toXML(defs);
    return xml;
  };

  it('serialises a scalar value+unit into the nested PhysicalQuantity carrier', async () => {
    const carrier = componentsCarrier(
      'MassFlow',
      buildCanonicalScalarValue(moddle as ModdleFactory, '48015.4', 'KilogramPerHour'),
    );
    const xml = await serialise([carrier]);
    expect(xml).toContain('<dexpi:aggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">');
    expect(xml).toContain('<dexpi:data property="Unit">KilogramPerHour</dexpi:data>');
    expect(xml).toContain('<dexpi:data property="Value">48015.4</dexpi:data>');
    // No flat Unit sibling directly on the QualifiedValue Object.
    expect(xml).not.toMatch(/property="Value">48015\.4<\/dexpi:data>\s*<dexpi:data property="Unit"/);
  });

  it('serialises a unit-less scalar as a flat Value (no aggregatedDataValue)', async () => {
    const carrier = componentsCarrier(
      'SomeCount',
      buildCanonicalScalarValue(moddle as ModdleFactory, '7'),
    );
    const xml = await serialise([carrier]);
    expect(xml).toContain('<dexpi:data property="Value">7</dexpi:data>');
    expect(xml).not.toContain('aggregatedDataValue');
  });

  it('serialises a vector into the nested PhysicalQuantityVector carrier', async () => {
    const carrier = componentsCarrier(
      'MoleFractiona',
      buildCanonicalVectorValue(moddle as ModdleFactory, ['0.9', '0.1'], 'Percent'),
    );
    const xml = await serialise([carrier]);
    expect(xml).toContain('<dexpi:aggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantityVector">');
    expect(xml).toContain('<dexpi:data property="Unit">Percent</dexpi:data>');
    expect((xml.match(/<dexpi:data property="Values">/g) ?? []).length).toBe(2);
  });

  it('round-trips: parse the emitted XML back and read value+unit via the shared reader', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamOf = (root: any) => {
      const flow = root.rootElements[0].flowElements.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.$type === 'bpmn:SequenceFlow');
      return flow.extensionElements.values[0];
    };
    const scalarXml = await serialise([componentsCarrier(
      'MassFlow', buildCanonicalScalarValue(moddle as ModdleFactory, '48015.4', 'KilogramPerHour'))]);
    const { rootElement } = await moddle.fromXML(scalarXml);
    const qv = streamOf(rootElement).components[0].objects[0];
    expect(readCanonicalScalar(qv.data)).toEqual({ value: '48015.4', unit: 'KilogramPerHour' });

    const vectorXml = await serialise([componentsCarrier(
      'MoleFractiona', buildCanonicalVectorValue(moddle as ModdleFactory, ['0.9', '0.1'], 'Percent'))]);
    const { rootElement: vRoot } = await moddle.fromXML(vectorXml);
    const vqv = streamOf(vRoot).components[0].objects[0];
    expect(readCanonicalVector(vqv.data)).toEqual({ values: ['0.9', '0.1'], unit: 'Percent' });
  });

  it('the transformer reads the moddle-emitted nested scalar (panel↔transformer agree)', async () => {
    // Serialise the helper output through moddle, lift out the exact
    // <dexpi:components property="MassFlow"> fragment moddle emits (the shape
    // tests above pin down), and feed it through a MaterialStateType — the
    // authoring path that emits a QualifiedValue without needing ports — to
    // prove the transformer consumes the moddle write shape unchanged.
    const carrierXml = await serialise([componentsCarrier(
      'MassFlow', buildCanonicalScalarValue(moddle as ModdleFactory, '48015.4', 'KilogramPerHour'))]);
    const fragment = carrierXml.match(/<dexpi:components property="MassFlow">[\s\S]*?<\/dexpi:components>/)?.[0];
    expect(fragment).toBeTruthy();

    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:dexpi="http://dexpi.org/schema/bpmn-extension"
             targetNamespace="urn:t">
  <process id="P1">
    <dataObjectReference id="DOR" name="States" dataObjectRef="DO1">
      <extensionElements>
        <dexpi:MaterialState uid="uuid_MS"><dexpi:data property="Identifier">1</dexpi:data>
          <dexpi:references property="State" uidRef="uuid_MST"/></dexpi:MaterialState>
        <dexpi:MaterialStateType uid="uuid_MST"><dexpi:data property="Identifier">1-State</dexpi:data>
          ${fragment}
        </dexpi:MaterialStateType>
      </extensionElements>
    </dataObjectReference>
    <dataObject id="DO1"/>
  </process>
</definitions>`;
    const t = new BpmnToDexpiTransformer();
    const out = await t.transform(bpmn, { processXml: PROCESS_XML, coreXml: CORE_XML });
    // The authored unit resolves to the canonical MassFlowRateUnit literal and
    // is emitted as a nested DataReference — exactly the canonical export shape.
    expect(out).toContain('<DataReference data="Core/PhysicalQuantities.MassFlowRateUnit.KilogramPerHour"/>');
  });

  it('serialises and round-trips the unitEnum quantity choice on the components carrier', async () => {
    // A custom measurement (MoleFlow) with a custom unit (KilomolePerHour) whose
    // quantity the user picked in the panel (MoleFlowRateUnit). The choice rides
    // on the carrier as the `unitEnum` attribute — the Profile generator reads it
    // to place the missing literal. Prove moddle neither strips it on write nor
    // loses it on read (the link the panel save + reader depend on).
    const carrier = moddle.create('dexpi:Components', {
      property: 'MoleFlow',
      unitEnum: 'MoleFlowRateUnit',
      objects: [moddle.create('dexpi:Object', {
        type: 'Core/QualifiedValue',
        data: [buildCanonicalScalarValue(moddle as ModdleFactory, '11.2', 'KilomolePerHour')],
      })],
    });
    const xml = await serialise([carrier]);
    expect(xml).toMatch(/<dexpi:components property="MoleFlow" unitEnum="MoleFlowRateUnit">/);

    // Round-trip: the attribute parses back onto the moddle element so the panel
    // readers (carrier.unitEnum) recover the choice on re-open.
    const { rootElement } = await moddle.fromXML(xml);
    const flowBack = rootElement.rootElements[0].flowElements.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => e.$type === 'bpmn:SequenceFlow');
    expect(flowBack.extensionElements.values[0].components[0].unitEnum).toBe('MoleFlowRateUnit');

    // A resolved unit needs no quantity, so a carrier built without unitEnum
    // stays attribute-free (the panel emits it only when the user picks one).
    const plain = moddle.create('dexpi:Components', {
      property: 'MassFlow',
      objects: [moddle.create('dexpi:Object', {
        type: 'Core/QualifiedValue',
        data: [buildCanonicalScalarValue(moddle as ModdleFactory, '48015.4', 'KilogramPerHour')],
      })],
    });
    expect(await serialise([plain])).not.toContain('unitEnum=');
  });

  it('readCanonicalScalar still reads a legacy flat Value + sibling Unit', () => {
    const legacy: ModdleElement[] = [
      { property: 'Value', body: '12.5' },
      { property: 'Unit', body: 'KilogramPerHour' },
    ];
    expect(readCanonicalScalar(legacy)).toEqual({ value: '12.5', unit: 'KilogramPerHour' });
  });
});
