/**
 * DexpiOutputValidator
 *
 * Validates DEXPI 2.0 XML produced by BpmnToDexpiTransformer.
 * The transformer emits the DEXPI linked-data object model:
 *
 *   <Model name="..." uri="...">
 *     <Import prefix="Core"    source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
 *     <Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
 *     <Object type="Core/EngineeringModel">
 *       <Components property="ConceptualModel">
 *         <Object type="Process/ProcessModel">
 *           <Components property="ProcessSteps">
 *             <Object id="uid-…" type="Process/Process.ReactingChemicals">…</Object>
 *           </Components>
 *         </Object>
 *       </Components>
 *     </Object>
 *   </Model>
 */

import type { ValidationResult } from './types';

export function validateDexpiOutput(xml: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: Document;
  try {
    if (typeof DOMParser !== 'undefined') {
      doc = new DOMParser().parseFromString(xml, 'text/xml');
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { JSDOM } = require('jsdom');
      doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
    }
  } catch {
    errors.push('Failed to parse generated XML as a DOM document.');
    return { valid: false, errors, warnings };
  }

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    errors.push(`Generated XML is not well-formed: ${(parseError.textContent ?? '').slice(0, 200)}`);
    return { valid: false, errors, warnings };
  }

  // Root must be <Model>
  const root = doc.documentElement;
  const rootLocal = root.localName || root.tagName.split(':').pop() || '';
  if (rootLocal !== 'Model') {
    errors.push(`Root element must be 'Model' (got '${rootLocal}').`);
    return { valid: false, errors, warnings };
  }

  // Check imports
  const imports = Array.from(root.children).filter(
    (c) => (c.localName || c.tagName.split(':').pop() || '') === 'Import'
  );
  const importSources = imports.map((i) => i.getAttribute('source') ?? '');
  if (!importSources.some((s) => s.includes('Core'))) {
    warnings.push('Missing Core import declaration.');
  }
  if (!importSources.some((s) => s.includes('Process'))) {
    warnings.push('Missing Process import declaration.');
  }

  // All top-level Object elements (direct children of root or direct children of Components)
  const allObjects = Array.from(doc.querySelectorAll('Object'));
  if (allObjects.length === 0) {
    errors.push('No <Object> elements found in generated DEXPI XML.');
    return { valid: false, errors, warnings };
  }

  // ProcessModel container
  const hasProcessModel = allObjects.some(
    (o) => o.getAttribute('type') === 'Process/ProcessModel'
  );
  if (!hasProcessModel) {
    warnings.push('No Process/ProcessModel container Object found.');
  }

  // ProcessStep objects are direct children of a Components[property="ProcessSteps"] element.
  // This avoids incorrectly flagging nested data objects (e.g. Composition fractions).
  const processStepContainers = Array.from(
    doc.querySelectorAll('Components[property="ProcessSteps"]')
  );

  if (processStepContainers.length === 0) {
    warnings.push('No <Components property="ProcessSteps"> container found — no ProcessSteps in output.');
  }

  let processStepCount = 0;
  processStepContainers.forEach((container) => {
    // Only direct Object children of the ProcessSteps container are process steps
    const stepObjects = Array.from(container.children).filter(
      (c) => (c.localName || c.tagName.split(':').pop() || '') === 'Object'
    );
    stepObjects.forEach((ps, i) => {
      processStepCount++;
      const id = ps.getAttribute('id');
      const type = ps.getAttribute('type') ?? '';
      if (!id) {
        errors.push(`ProcessStep Object[${i}] (type=${type}) is missing required 'id' attribute.`);
      }
    });
  });

  if (processStepCount === 0 && processStepContainers.length > 0) {
    warnings.push('ProcessSteps container is empty — no process step Objects found.');
  }

  return { valid: errors.length === 0, errors, warnings };
}
