/**
 * DexpiImportWithElk
 *
 * Glue between the DEXPI→BPMN reverse transformer and the ELK layout
 * engine. Pipeline:
 *
 *   1. DexpiToBpmnTransformer.transform(dexpiXml) → BPMN string with
 *      the importer's own (heuristic) layout written into bpmndi:BPMNDiagram.
 *   2. relayoutBpmnFile(...) parses the BPMN, runs ELK over the
 *      node/edge graph, and writes back a fresh bpmndi:BPMNDiagram with
 *      ELK's positions.
 *
 * The result preserves all logical content (process / tasks / sequence
 * flows / dexpi:extensionElements) verbatim — only the diagram positions
 * differ. Side-by-side comparison with `t.transform(dexpiXml)` directly
 * shows the layout-quality delta cleanly.
 *
 * Use this entry point when you want ELK-quality layout on imported DEXPI
 * models. Use the transformer directly when you want to preserve the
 * importer's own layout heuristics (e.g. for diff comparison or when
 * ELK proves unsuitable).
 */

import { DexpiToBpmnTransformer, type DexpiToBpmnTransformOptions } from './DexpiToBpmnTransformer';
import { relayoutBpmnFile } from '../layout/BpmnFileRelayout';

export interface ImportWithElkOptions extends DexpiToBpmnTransformOptions {
  /**
   * Skip the ELK relayout pass. Equivalent to calling
   * DexpiToBpmnTransformer.transform() directly. Useful for A/B comparison.
   */
  skipElk?: boolean;
}

/**
 * Import a DEXPI XML document, optionally re-layouting the result with ELK.
 *
 * @param dexpiXml  DEXPI 2.0 XML string (the kind BpmnToDexpiTransformer
 *                  emits or that one would receive from another DEXPI tool).
 * @param options   Same options the underlying importer accepts, plus
 *                  `skipElk` to disable the layout pass.
 * @returns         BPMN 2.0 XML string ready to load into a bpmn-js
 *                  modeler / Camunda / SemTalk / etc.
 */
export async function importDexpiWithElk(
  dexpiXml: string,
  options: ImportWithElkOptions = {},
): Promise<string> {
  const transformer = new DexpiToBpmnTransformer();
  const bpmn = await transformer.transform(dexpiXml, options);
  if (options.skipElk) return bpmn;
  return relayoutBpmnFile(bpmn);
}
