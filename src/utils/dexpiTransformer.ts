// @ts-expect-error xml2js has no type declarations
import { parseString, Builder } from 'xml2js';

// ── Minimal types for xml2js-parsed BPMN nodes ──────────────────────────────

type XmlNode = Record<string, unknown>;
type XmlAttr = Record<string, string>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function nodeAttr(node: unknown): XmlAttr {
  if (!isRecord(node)) return {};
  const a = (node as Record<string, unknown>)['$'];
  return isRecord(a) ? (a as XmlAttr) : {};
}

function nodeChildren(node: unknown, key: string): unknown[] {
  if (!isRecord(node)) return [];
  const v = (node as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

function first(arr: unknown[]): unknown {
  return arr[0];
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function exportToDexpiXml(bpmnXml: string): Promise<string> {
  return new Promise((resolve, reject) => {
    parseString(bpmnXml, (err: Error | null, result: Record<string, unknown>) => {
      if (err) { reject(err); return; }
      try {
        resolve(transformBpmnToDexpi(result));
      } catch (error) {
        reject(error);
      }
    });
  });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function buildPort(port: unknown): XmlNode {
  const a = nodeAttr(port);
  return { Port: { $: { ID: a.portId, Name: a.name, Type: a.portType, Direction: a.direction } } };
}

function buildPorts(ports: unknown[]): XmlNode[] {
  return ports.map(buildPort);
}

function extractDexpiElement(bpmnElement: unknown): unknown {
  const ext = first(nodeChildren(bpmnElement, 'extensionElements'));
  if (!ext) return null;
  return first(nodeChildren(ext, 'dexpi:Element')) ?? null;
}

function extractDexpiStream(bpmnFlow: unknown): unknown {
  const ext = first(nodeChildren(bpmnFlow, 'extensionElements'));
  if (!ext) return null;
  return first(nodeChildren(ext, 'dexpi:Stream')) ?? null;
}

// ── Core transform ────────────────────────────────────────────────────────────

function transformBpmnToDexpi(bpmnData: unknown): string {
  if (!isRecord(bpmnData)) throw new Error('Invalid BPMN structure');

  const defs = first(nodeChildren(bpmnData, 'bpmn:definitions'));
  const process = first(nodeChildren(defs, 'bpmn:process'));
  if (!process) throw new Error('Invalid BPMN structure');

  const model: XmlNode = {
    $: {
      xmlns: 'http://www.dexpi.org/2023/schema',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      SchemaVersion: '3.0',
    },
    ProcessSteps: [],
    Sources: [],
    Sinks: [],
    Streams: [],
    MaterialTemplates: [],
    MaterialStates: [],
  };

  // Tasks → ProcessSteps / InstrumentationActivities
  for (const task of nodeChildren(process, 'bpmn:task')) {
    const el = extractDexpiElement(task);
    if (!el) continue;
    const a = nodeAttr(el);
    const ta = nodeAttr(task);
    const step: XmlNode = { $: { ID: a.identifier || ta.id, Name: ta.name || '' }, Ports: buildPorts(nodeChildren(el, 'dexpi:Port')) };
    if (a.dexpiType === 'InstrumentationActivity') {
      if (!model.InstrumentationActivities) model.InstrumentationActivities = [];
      (model.InstrumentationActivities as XmlNode[]).push({ InstrumentationActivity: step });
    } else {
      (model.ProcessSteps as XmlNode[]).push({ ProcessStep: step });
    }
  }

  // StartEvents → Sources
  for (const ev of nodeChildren(process, 'bpmn:startEvent')) {
    const el = extractDexpiElement(ev);
    const ea = nodeAttr(ev);
    const src: XmlNode = { $: { ID: nodeAttr(el).identifier || ea.id, Name: ea.name || 'Source' }, Ports: buildPorts(nodeChildren(el, 'dexpi:Port')) };
    (model.Sources as XmlNode[]).push({ Source: src });
  }

  // EndEvents → Sinks
  for (const ev of nodeChildren(process, 'bpmn:endEvent')) {
    const el = extractDexpiElement(ev);
    const ea = nodeAttr(ev);
    const snk: XmlNode = { $: { ID: nodeAttr(el).identifier || ea.id, Name: ea.name || 'Sink' }, Ports: buildPorts(nodeChildren(el, 'dexpi:Port')) };
    (model.Sinks as XmlNode[]).push({ Sink: snk });
  }

  // SequenceFlows → Streams
  for (const flow of nodeChildren(process, 'bpmn:sequenceFlow')) {
    const ds = extractDexpiStream(flow);
    const fa = nodeAttr(flow);
    const da = nodeAttr(ds);
    const stream: XmlNode = {
      $: {
        ID: da.identifier || fa.id,
        Name: da.name || fa.name || 'Stream',
        SourceRef: fa.sourceRef,
        TargetRef: fa.targetRef,
        ...(da.streamType && { Type: da.streamType }),
        ...(da.sourcePortRef && { SourcePortRef: da.sourcePortRef }),
        ...(da.targetPortRef && { TargetPortRef: da.targetPortRef }),
        ...(da.templateReference && { TemplateReference: da.templateReference }),
        ...(da.materialStateReference && { MaterialStateReference: da.materialStateReference }),
        ...(da.provenance && { Provenance: da.provenance }),
        ...(da.range && { Range: da.range }),
      },
    };
    const attrs = nodeChildren(ds, 'dexpi:StreamAttribute');
    if (attrs.length) {
      stream.Attributes = attrs.map(attr => {
        const aa = nodeAttr(attr);
        return { Attribute: { $: { Name: aa.name, Value: aa.value, Unit: aa.unit || '', Mode: aa.mode || '', Qualifier: aa.qualifier || '' } } };
      });
    }
    (model.Streams as XmlNode[]).push({ Stream: stream });
  }

  // DataObjectReferences → MaterialTemplates / MaterialStates
  for (const dataObj of nodeChildren(process, 'bpmn:dataObjectReference')) {
    const ext = first(nodeChildren(dataObj, 'extensionElements'));
    if (!ext) continue;

    for (const mt of nodeChildren(ext, 'dexpi:MaterialTemplate')) {
      const a = nodeAttr(mt); const da = nodeAttr(dataObj);
      const tmpl: XmlNode = { $: { ID: a.identifier || da.id, Name: a.name || da.name || 'Material Template', UID: a.uid || a.identifier } };
      const comps = nodeChildren(mt, 'dexpi:Component');
      if (comps.length) tmpl.Components = comps.map(c => { const ca = nodeAttr(c); return { Component: { $: { Name: ca.name, CASNumber: ca.casNumber || '', Fraction: ca.fraction || '' } } }; });
      (model.MaterialTemplates as XmlNode[]).push({ MaterialTemplate: tmpl });
    }

    for (const ms of nodeChildren(ext, 'dexpi:MaterialState')) {
      const a = nodeAttr(ms); const da = nodeAttr(dataObj);
      const state: XmlNode = { $: { ID: a.identifier || da.id, Name: a.name || da.name || 'Material State', UID: a.uid || a.identifier, TemplateRef: a.templateRef || '', ...(a.provenance && { Provenance: a.provenance }), ...(a.range && { Range: a.range }) } };
      const props = nodeChildren(ms, 'dexpi:StateProperty');
      if (props.length) state.Properties = props.map(p => { const pa = nodeAttr(p); return { Property: { $: { Name: pa.name, Value: pa.value, Unit: pa.unit || '' } } }; });
      (model.MaterialStates as XmlNode[]).push({ MaterialState: state });
    }
  }

  const builder = new Builder({ xmldec: { version: '1.0', encoding: 'UTF-8' }, renderOpts: { pretty: true, indent: '  ' } });
  return builder.buildObject({ ProcessModel: model });
}
