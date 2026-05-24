/**
 * Pins the property names emitted on `:ProcessStep` family nodes so
 * downstream consumers (the Bloom perspective + the Python enrichment
 * pipeline under `scripts/enrich/`) stay compatible.
 *
 * Contract:
 *   - `name` is set to the DEXPI class (`step.type`), so the bundled
 *     enrichment queries' `coalesce(n.name, n.label)` lookup hits the
 *     RDL-resolvable class name instead of the free-text BPMN caption.
 *   - snake_case port aliases live alongside the existing camelCase ones.
 *   - port counts and `is_instrumentation_activity` are derived without
 *     requiring the consumer to run a normalisation pass.
 */

import { describe, it, expect } from 'vitest';
import type { DexpiGraphData, ProcessStepNode } from '../neo4jExporter';
import { generateCypherQueries } from '../neo4jExporter';

const emptyAttrs = {};

function makeStep(overrides: Partial<ProcessStepNode>): ProcessStepNode {
  return {
    id: 'step-1',
    identifier: 'PS1',
    label: 'Cool the gas',
    type: 'Cooling',
    nodeType: 'ProcessStep',
    hierarchy_level: 0,
    isSubProcess: false,
    isNavigational: false,
    inputPorts: ['MI1', 'MI2'],
    outputPorts: ['MO1'],
    attributes: emptyAttrs,
    ...overrides,
  };
}

function makeData(steps: ProcessStepNode[]): DexpiGraphData {
  return {
    processSteps: steps,
    ports: new Map(),
    streams: [],
    materialTemplates: [],
    materialComponents: [],
    materialStates: [],
    materialStateTypes: [],
  };
}

describe('neo4jExporter — :ProcessStep enrichment-friendly aliases', () => {
  it('sets name = type so coalesce(n.name, n.label) hits the DEXPI class', () => {
    const queries = generateCypherQueries(makeData([makeStep({})]), { clearDatabase: false });
    const createStmt = queries.find((q) => q.startsWith('CREATE (:ProcessStep:Cooling'));
    expect(createStmt).toBeDefined();
    expect(createStmt).toContain("name: 'Cooling'");
    // The free-text BPMN caption is preserved separately.
    expect(createStmt).toContain("label: 'Cool the gas'");
  });

  it('emits snake_case port aliases alongside camelCase', () => {
    const queries = generateCypherQueries(makeData([makeStep({})]), { clearDatabase: false });
    const createStmt = queries.find((q) => q.startsWith('CREATE (:ProcessStep:Cooling')) ?? '';
    expect(createStmt).toContain("inputPorts: ['MI1', 'MI2']");
    expect(createStmt).toContain("outputPorts: ['MO1']");
    expect(createStmt).toContain("input_ports: ['MI1', 'MI2']");
    expect(createStmt).toContain("output_ports: ['MO1']");
  });

  it('derives port counts directly from the arrays', () => {
    const queries = generateCypherQueries(makeData([makeStep({})]), { clearDatabase: false });
    const createStmt = queries.find((q) => q.startsWith('CREATE (:ProcessStep:Cooling')) ?? '';
    expect(createStmt).toContain('input_ports_count: 2');
    expect(createStmt).toContain('output_ports_count: 1');
  });

  it('flags instrumentation activities with a boolean alias', () => {
    const sensorStep = makeStep({
      id: 'instr-1',
      type: 'MeasuringProcessVariable',
      nodeType: 'InstrumentationActivity',
    });
    const queries = generateCypherQueries(makeData([sensorStep]), { clearDatabase: false });
    const instrStmt = queries.find((q) => q.startsWith('CREATE (:InstrumentationActivity'));
    expect(instrStmt).toBeDefined();
    expect(instrStmt).toContain('is_instrumentation_activity: true');
  });

  it('flags non-instrumentation nodes as is_instrumentation_activity: false', () => {
    const queries = generateCypherQueries(makeData([makeStep({})]), { clearDatabase: false });
    const createStmt = queries.find((q) => q.startsWith('CREATE (:ProcessStep:Cooling')) ?? '';
    expect(createStmt).toContain('is_instrumentation_activity: false');
  });
});
