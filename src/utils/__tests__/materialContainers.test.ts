/**
 * Regression test for content-based MaterialStates / MaterialTemplates
 * DataObjectReference detection. The UI previously located these
 * containers by `businessObject.name === 'MaterialStates'` / `=== 'MaterialTemplates'`,
 * which silently misrouted in any BPMN file where the user renamed the
 * shape (or the file came from a different authoring tool). The helpers
 * here identify containers by what their extensionElements contain.
 */

import { describe, it, expect } from 'vitest';
import {
  isMaterialStatesContainer,
  isMaterialTemplatesContainer,
  findMaterialStatesContainer,
  findMaterialTemplatesContainer,
  findAllMaterialStatesContainers,
} from '../materialContainers';

// Minimal moddle-shape fixture builders. The helpers care about
// `el.type`, `el.businessObject.extensionElements.values[].$type` only.
const dataObjectRef = (name: string, values: Array<{ $type: string }>) => ({
  type: 'bpmn:DataObjectReference',
  businessObject: {
    name,
    extensionElements: { values },
  },
});

describe('materialContainers — content-based detection', () => {
  it('identifies a MaterialStates container holding direct MaterialState entries', () => {
    const el = dataObjectRef('renamed-by-user', [
      { $type: 'dexpi:MaterialState' },
    ]);
    expect(isMaterialStatesContainer(el)).toBe(true);
    expect(isMaterialTemplatesContainer(el)).toBe(false);
  });

  it('identifies a MaterialStates container holding Case-wrapped states', () => {
    const el = dataObjectRef('Cases for plant A', [
      { $type: 'dexpi:Case' },
    ]);
    expect(isMaterialStatesContainer(el)).toBe(true);
  });

  it('identifies a MaterialTemplates container by MaterialTemplate entries', () => {
    const el = dataObjectRef('whatever', [
      { $type: 'dexpi:MaterialTemplate' },
    ]);
    expect(isMaterialTemplatesContainer(el)).toBe(true);
    expect(isMaterialStatesContainer(el)).toBe(false);
  });

  it('identifies a MaterialTemplates container by MaterialComponent entries', () => {
    const el = dataObjectRef('Library', [
      { $type: 'dexpi:MaterialComponent' },
    ]);
    expect(isMaterialTemplatesContainer(el)).toBe(true);
  });

  it('accepts both prefixed and bare $type strings', () => {
    const prefixed = dataObjectRef('x', [{ $type: 'dexpi:MaterialState' }]);
    const bare     = dataObjectRef('x', [{ $type: 'MaterialState' }]);
    expect(isMaterialStatesContainer(prefixed)).toBe(true);
    expect(isMaterialStatesContainer(bare)).toBe(true);
  });

  it('rejects non-DataObjectReference elements even with matching content', () => {
    const fake = {
      type: 'bpmn:Task',
      businessObject: { extensionElements: { values: [{ $type: 'dexpi:MaterialState' }] } },
    };
    expect(isMaterialStatesContainer(fake)).toBe(false);
    expect(isMaterialTemplatesContainer(fake)).toBe(false);
  });

  it('rejects DataObjectReferences with no extensionElements', () => {
    const el = { type: 'bpmn:DataObjectReference', businessObject: { name: 'MaterialStates' } };
    expect(isMaterialStatesContainer(el)).toBe(false);
    expect(isMaterialTemplatesContainer(el)).toBe(false);
  });

  it('rejects DataObjectReferences whose extensionElements carry unrelated content', () => {
    const el = dataObjectRef('MaterialStates', [
      { $type: 'dexpi:SomethingElse' },
    ]);
    expect(isMaterialStatesContainer(el)).toBe(false);
    expect(isMaterialTemplatesContainer(el)).toBe(false);
  });

  it('finders pick the right container regardless of name', () => {
    const renamedStates = dataObjectRef('PlantA-States', [{ $type: 'dexpi:MaterialState' }]);
    const renamedTpls   = dataObjectRef('PlantA-Templates', [{ $type: 'dexpi:MaterialTemplate' }]);
    const unrelated     = dataObjectRef('SomeOtherShape', [{ $type: 'dexpi:Equipment' }]);
    const all = [unrelated, renamedTpls, renamedStates];
    expect(findMaterialStatesContainer(all)).toBe(renamedStates);
    expect(findMaterialTemplatesContainer(all)).toBe(renamedTpls);
    expect(findAllMaterialStatesContainers(all)).toEqual([renamedStates]);
  });

  it('findAllMaterialStatesContainers returns every match for multi-case-per-container layouts', () => {
    const a = dataObjectRef('Case A', [{ $type: 'dexpi:MaterialState' }]);
    const b = dataObjectRef('Case B', [{ $type: 'dexpi:Case' }]);
    expect(findAllMaterialStatesContainers([a, b])).toEqual([a, b]);
  });
});
