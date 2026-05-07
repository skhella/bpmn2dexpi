#!/usr/bin/env node
/**
 * CLI: relayout a BPMN file using ELK.
 *
 * Usage:
 *   node scripts/relayout-bpmn.mjs <input.bpmn> <output.bpmn>
 *
 * Reads <input.bpmn>, runs ELK layout on the node/edge graph, writes
 * <output.bpmn> with a fresh bpmndi:BPMNDiagram block. Logical content
 * (process / tasks / sequenceFlows / dexpi:extensionElements) is
 * preserved verbatim.
 */

import { readFileSync, writeFileSync } from 'fs';
import { JSDOM } from 'jsdom';

// jsdom polyfill for DOMParser/XMLSerializer used by BpmnFileRelayout.
const dom = new JSDOM('<!DOCTYPE html>');
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  Document: dom.window.Document,
  Element: dom.window.Element,
});

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/relayout-bpmn.mjs <input.bpmn> <output.bpmn>');
  process.exit(1);
}

const [inputPath, outputPath] = args;

// Dynamic import so we can use TypeScript's compiled output via tsx, or
// just call the .ts directly when running under tsx.
const { relayoutBpmnFile } = await import('../src/layout/BpmnFileRelayout.ts');

const inputXml = readFileSync(inputPath, 'utf-8');
console.log(`Read ${inputPath} (${inputXml.length} bytes)`);

const startMs = Date.now();
const outputXml = await relayoutBpmnFile(inputXml);
const elapsedMs = Date.now() - startMs;

writeFileSync(outputPath, outputXml);
console.log(`Wrote ${outputPath} (${outputXml.length} bytes) in ${elapsedMs}ms`);
