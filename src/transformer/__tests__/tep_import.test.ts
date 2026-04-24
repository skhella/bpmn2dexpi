import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BpmnToDexpiTransformer } from '../BpmnToDexpiTransformer';
import { DexpiToBpmnTransformer } from '../DexpiToBpmnTransformer';

describe('TEP DEXPI import', () => {
  it('transforms TEP DEXPI output back to BPMN', async () => {
    const bpmn = readFileSync(join(__dirname, '../../../examples/Tennessee_Eastman_Process.bpmn'), 'utf8');
    const dexpi = await new BpmnToDexpiTransformer().transform(bpmn);

    // Write DEXPI for inspection
    writeFileSync(join(__dirname, '../../../examples/Tennessee_Eastman_Process_exported.xml'), dexpi);

    const bpmn2 = new DexpiToBpmnTransformer().transform(dexpi);

    // Write generated BPMN for browser testing
    writeFileSync(join(__dirname, '../../../examples/Tennessee_Eastman_Process_reimported.bpmn'), bpmn2);

    const steps = [...bpmn2.matchAll(/dexpiType="([^"]+)"/g)].map(m => m[1]);
    const stepTypes = [...new Set(steps)];
    console.log('\nStep types in re-imported BPMN:', stepTypes);

    const shapes = [...bpmn2.matchAll(/dc:Bounds/g)].length;
    const flows = [...bpmn2.matchAll(/bpmn:sequenceFlow/g)].length;
    const assocs = [...bpmn2.matchAll(/bpmn:association/g)].length;
    console.log(`Shapes: ${shapes}, SequenceFlows: ${flows}, Associations: ${assocs}`);
    console.log(`Output size: ${(bpmn2.length/1024).toFixed(1)} KB`);

    expect(bpmn2).toContain('bpmn:definitions');
    expect(bpmn2).toContain('dexpiType="Pumping"');
    expect(shapes).toBeGreaterThan(10);
  }, 60000);
});
