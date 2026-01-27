#!/usr/bin/env node

/**
 * CLI tool for converting BPMN files to DEXPI XML
 * Usage: node cli.js input.bpmn [output.xml]
 * Or: npm run transform input.bpmn [output.xml]
 */

import { readFileSync, writeFileSync } from 'fs';
import { transformer } from './src/transformer/BpmnToDexpiTransformer.ts';
import { JSDOM } from 'jsdom';

// Set up DOM globals for Node.js environment
const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Document = dom.window.Document;
global.Element = dom.window.Element;

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
DEXPI Process Tool - BPMN to DEXPI XML Transformer

Usage:
  node cli.js <input.bpmn> [output.xml]
  npm run transform <input.bpmn> [output.xml]

Arguments:
  input.bpmn   Path to input BPMN file (required)
  output.xml   Path to output DEXPI XML file (optional, prints to stdout if not provided)

Examples:
  node cli.js process.bpmn                  # Print DEXPI XML to console
  node cli.js process.bpmn output.xml       # Save DEXPI XML to file
  npm run transform process.bpmn output.xml # Using npm script

From Python:
  import subprocess
  result = subprocess.run(['node', 'cli.js', 'input.bpmn'], capture_output=True, text=True)
  dexpi_xml = result.stdout
`);
  process.exit(0);
}

const inputPath = args[0];
const outputPath = args[1];

async function main() {
  try {
    // Read BPMN file
    const bpmnXml = readFileSync(inputPath, 'utf-8');
    
    // Transform to DEXPI
    const dexpiXml = await transformer.transform(bpmnXml);
    
    if (outputPath) {
      // Write to file
      writeFileSync(outputPath, dexpiXml, 'utf-8');
      console.error(`✓ Successfully transformed ${inputPath} → ${outputPath}`);
    } else {
      // Print to stdout
      console.log(dexpiXml);
    }
    
    process.exit(0);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
