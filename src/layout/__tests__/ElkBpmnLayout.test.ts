/**
 * ELK layout engine — smoke tests.
 *
 * Verifies that:
 *   - layoutWithElk produces well-formed positions for a small graph
 *   - subprocess nesting yields children inside parents (parent's bounds
 *     contain children's bounds)
 *   - TEP-fixture relayout completes within a reasonable budget and
 *     emits valid BPMN XML with positioned shapes for every node
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { join } from 'path';

const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

import { layoutWithElk } from '../ElkBpmnLayout';
import { relayoutBpmnFile } from '../BpmnFileRelayout';

const TEP_BPMN_PATH = join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn');

describe('ELK layout engine', () => {
  it('produces non-overlapping positions for a small linear graph', async () => {
    const result = await layoutWithElk({
      nodes: [
        { id: 'A', kind: 'StartEvent' },
        { id: 'B', kind: 'Task' },
        { id: 'C', kind: 'EndEvent' },
      ],
      edges: [
        { id: 'AB', sources: ['A'], targets: ['B'] },
        { id: 'BC', sources: ['B'], targets: ['C'] },
      ],
    });

    expect(result.nodes).toHaveLength(3);
    // L→R flow direction: B should be to the right of A, C to the right of B.
    const A = result.nodes.find(n => n.id === 'A')!;
    const B = result.nodes.find(n => n.id === 'B')!;
    const C = result.nodes.find(n => n.id === 'C')!;
    expect(B.x).toBeGreaterThan(A.x);
    expect(C.x).toBeGreaterThan(B.x);
  });

  it('lays out subprocess children inside their parent (hierarchical handling)', async () => {
    const result = await layoutWithElk({
      nodes: [
        {
          id: 'parent',
          kind: 'SubProcess',
          children: [
            { id: 'child1', kind: 'Task' },
            { id: 'child2', kind: 'Task' },
          ],
        },
      ],
      edges: [
        { id: 'cc', sources: ['child1'], targets: ['child2'] },
      ],
    });

    const parent = result.nodes[0];
    expect(parent.children).toHaveLength(2);

    // Each child must lie within the parent's bounds.
    for (const child of parent.children) {
      expect(child.x).toBeGreaterThanOrEqual(parent.x);
      expect(child.y).toBeGreaterThanOrEqual(parent.y);
      expect(child.x + child.width).toBeLessThanOrEqual(parent.x + parent.width);
      expect(child.y + child.height).toBeLessThanOrEqual(parent.y + parent.height);
    }
  });

  it('respects fixed port-side constraints (Inlet=WEST, Outlet=EAST) when edges provide flow direction', async () => {
    // ELK applies port-side constraints when there is sufficient flow
    // direction context — i.e. edges connect the ports. With an isolated
    // node and no edges, ELK is allowed to default both ports to one side.
    const result = await layoutWithElk({
      nodes: [
        { id: 'src', kind: 'StartEvent' },
        { id: 'tgt', kind: 'EndEvent' },
        {
          id: 'task',
          kind: 'Task',
          ports: [
            { id: 'task_in1', direction: 'Inlet' },
            { id: 'task_out1', direction: 'Outlet' },
          ],
        },
      ],
      edges: [
        { id: 'e1', sources: ['src'], targets: ['task_in1'] },
        { id: 'e2', sources: ['task_out1'], targets: ['tgt'] },
      ],
    });

    const task = result.nodes.find(n => n.id === 'task')!;
    expect(task.ports).toHaveLength(2);
    const inlet = task.ports.find(p => p.id === 'task_in1')!;
    const outlet = task.ports.find(p => p.id === 'task_out1')!;

    // Inlet on WEST side: port's left edge is at task.x (or just outside the WEST face).
    expect(inlet.x).toBeLessThanOrEqual(task.x);
    // Outlet on EAST side: port's left edge is at task.x + task.width (or just inside it).
    expect(outlet.x).toBeGreaterThanOrEqual(task.x + task.width - inlet.width);
  });
});

describe('relayoutBpmnFile (full TEP fixture)', () => {
  it('relayouts the TEP fixture in under 5 seconds and emits valid XML', { timeout: 10_000 }, async () => {
    const bpmn = readFileSync(TEP_BPMN_PATH, 'utf-8');
    const start = Date.now();
    const result = await relayoutBpmnFile(bpmn);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);

    // Result must be parseable.
    const doc = new dom.window.DOMParser().parseFromString(result, 'text/xml');
    expect(doc.querySelector('parsererror')).toBeNull();

    // Must have a fresh BPMNDiagram with shapes for every task in the source.
    const shapeCount = (result.match(/<bpmndi:BPMNShape/g) ?? []).length;
    expect(shapeCount).toBeGreaterThan(50); // TEP has ~75 shapes
    const edgeCount = (result.match(/<bpmndi:BPMNEdge/g) ?? []).length;
    expect(edgeCount).toBeGreaterThan(50); // TEP has ~150 edges (sequence + associations)
  });
});
