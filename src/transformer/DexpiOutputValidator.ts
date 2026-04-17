/**
 * DexpiOutputValidator (R1-C2)
 *
 * Validates DEXPI 2.0 XML produced by BpmnToDexpiTransformer against the
 * official DEXPI XML Schema (DEXPI_XML_Schema.xsd, bundled in dexpi-schema-files/).
 *
 * In Node / CLI environments (where child_process is available), full XSD
 * validation is performed via xmllint.  In browser environments, a structural
 * fallback checks the key invariants of the DEXPI 2.0 object model.
 */

import type { ValidationResult } from './types';

// ── Node-only XSD validation ───────────────────────────────────────────────
export async function validateDexpiOutputXsd(
  xml: string,
  xsdPath: string
): Promise<ValidationResult> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { writeFile: wf, unlink: ul } = await import('fs/promises');

    const tmpFile = join(tmpdir(), `dexpi_validate_${Date.now()}.xml`);
    await wf(tmpFile, xml, 'utf-8');

    return new Promise<ValidationResult>(resolve => {
      const execFileP = promisify(execFile);
      execFileP('xmllint', ['--noout', '--schema', xsdPath, tmpFile])
        .then(() => {
          ul(tmpFile).catch(() => {});
          resolve({ valid: true, errors: [], warnings: [] });
        })
        .catch((err: { stderr?: string; stdout?: string }) => {
          ul(tmpFile).catch(() => {});
          const output = (err.stderr || err.stdout || String(err));
          const errors = output
            .split('\n')
            .filter(l => l.includes('error') || l.includes('fails to validate'))
            .map(l => l.trim())
            .filter(Boolean);
          resolve({ valid: false, errors, warnings: [] });
        });
    });
  } catch {
    // child_process not available (browser) — fall back to structural checks
    return validateDexpiOutput(xml);
  }
}

// ── Structural fallback (browser-safe) ────────────────────────────────────
export function validateDexpiOutput(xml: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: Document;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(xml, 'text/xml');
  } catch {
    errors.push('Failed to parse generated XML.');
    return { valid: false, errors, warnings };
  }

  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    errors.push(`Generated XML is not well-formed: ${(parseErr.textContent ?? '').slice(0, 200)}`);
    return { valid: false, errors, warnings };
  }

  const root = doc.documentElement;
  const rootLocal = root.localName || root.tagName.split(':').pop() || '';
  if (rootLocal !== 'Model') {
    errors.push(`Root element must be 'Model' (got '${rootLocal}').`);
    return { valid: false, errors, warnings };
  }

  const imports = Array.from(root.children).filter(
    c => (c.localName || c.tagName.split(':').pop()) === 'Import'
  );
  if (!imports.some(i => i.getAttribute('prefix') === 'Core'))
    warnings.push('Missing <Import prefix="Core"> declaration.');
  if (!imports.some(i => i.getAttribute('prefix') === 'Process'))
    warnings.push('Missing <Import prefix="Process"> declaration.');

  const allObjects = Array.from(doc.querySelectorAll('Object'));
  if (allObjects.length === 0) {
    errors.push('No <Object> elements found in generated DEXPI XML.');
    return { valid: false, errors, warnings };
  }

  const processModel = allObjects.find(
    o => (o.getAttribute('type') ?? '').includes('ProcessModel')
  );
  if (!processModel)
    warnings.push('No Object with type="Process/ProcessModel" found.');

  // ProcessStep Objects — only check DIRECT children of Components[property="ProcessSteps"]
  // Nested objects (Composition, Port, QualifiedValue) have optional id per XSD
  const topLevelStepObjects: Element[] = processModel
    ? Array.from(processModel.querySelectorAll('Components'))
        .filter(c => c.getAttribute('property') === 'ProcessSteps')
        .flatMap(comp => Array.from(comp.children)
          .filter(c => (c.localName || c.tagName.split(':').pop()) === 'Object') as Element[])
    : [];

  if (topLevelStepObjects.length === 0)
    warnings.push('No ProcessStep Object elements (type="Process/Process.*") found.');

  topLevelStepObjects.forEach((obj, i) => {
    const id   = obj.getAttribute('id');
    const type = obj.getAttribute('type');
    if (!id)   errors.push(`ProcessStep Object[${i}] (type=${type ?? '?'}) is missing required 'id'.`);
    if (!type) errors.push(`ProcessStep Object[${i}] (id=${id ?? '?'}) is missing required 'type'.`);
  });

  if (processModel) {
    Array.from(processModel.querySelectorAll('Components'))
      .filter(c => c.getAttribute('property') === 'ProcessConnections')
      .forEach(comp => {
        Array.from(comp.children)
          .filter(c => (c.localName || c.tagName.split(':').pop()) === 'Object')
          .forEach((obj, i) => {
            if (!obj.getAttribute('id'))
              errors.push(`ProcessConnection Object[${i}] is missing required 'id'.`);
          });
      });
  }

  return { valid: errors.length === 0, errors, warnings };
}
