#!/usr/bin/env node

/**
 * CLI tool for converting BPMN files to DEXPI XML
 * Usage: node cli.js input.bpmn [output.xml]
 * Or: npm run transform input.bpmn [output.xml]
 */

import { readFileSync, writeFileSync } from 'fs';
import { transformer } from './src/transformer/BpmnToDexpiTransformer.ts';
import { exportToNeo4j } from './src/utils/neo4jExporter.ts';
import { JSDOM } from 'jsdom';

// Set up DOM globals for Node.js environment
const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Document = dom.window.Document;
global.Element = dom.window.Element;

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
bpmn2dexpi - BPMN/DEXPI CLI Utilities

Commands:
  bpmn2dexpi <input.bpmn> [output.xml]          Transform BPMN to DEXPI XML
  bpmn2dexpi neo4j-export <input> [options]      Export to Neo4j database

Run 'bpmn2dexpi <command> --help' for command-specific help.

Examples:
  node cli.js process.bpmn output.xml
  node cli.js neo4j-export process.bpmn --uri bolt://localhost:7687 --user neo4j --password secret
`);
}

function printNeo4jHelp() {
  console.log(`
bpmn2dexpi neo4j-export - Export BPMN/DEXPI to Neo4j

Usage:
  bpmn2dexpi neo4j-export <input.{bpmn|xml}> --uri <uri> --user <user> --password <password> [options]

Required:
  <input>                    Path to BPMN or DEXPI XML file
  --uri <uri>                Neo4j URI (bolt://localhost:7687 or neo4j+s://xxx.databases.neo4j.io)
  --user <user>              Neo4j username
  --password <password>      Neo4j password

Optional:
  --database <database>      Neo4j database (default: neo4j)
  --input-type <bpmn|dexpi>  Force input type (auto-detected by file extension if omitted)
  --dexpi-out <path>         Save generated DEXPI XML when input is BPMN

Examples:
  # BPMN input (auto-transforms to DEXPI before export)
  node cli.js neo4j-export process.bpmn --uri bolt://localhost:7687 --user neo4j --password secret

  # DEXPI input
  node cli.js neo4j-export output.xml --input-type dexpi --uri bolt://localhost:7687 --user neo4j --password secret

  # Save intermediate DEXPI while exporting
  node cli.js neo4j-export process.bpmn --uri bolt://localhost:7687 --user neo4j --password secret --dexpi-out output.xml
`);
}

function parseOptions(optionArgs) {
  const options = {};
  for (let i = 0; i < optionArgs.length; i++) {
    const key = optionArgs[i];
    if (!key.startsWith('--')) {
      continue;
    }
    const value = optionArgs[i + 1];
    if (value === undefined || value.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = value;
    i += 1;
  }
  return options;
}

function detectInputType(inputPath) {
  const lower = inputPath.toLowerCase();
  if (lower.endsWith('.bpmn')) return 'bpmn';
  if (lower.endsWith('.xml')) return 'dexpi';
  return null;
}

async function runTransform(inputPath, outputPath) {
  // Read BPMN file
  const bpmnXml = readFileSync(inputPath, 'utf-8');

  // Transform to DEXPI
  const dexpiXml = await transformer.transform(bpmnXml);

  if (outputPath) {
    // Write to file
    writeFileSync(outputPath, dexpiXml, 'utf-8');
    console.error(`✓ Successfully transformed ${inputPath} -> ${outputPath}`);
  } else {
    // Print to stdout
    console.log(dexpiXml);
  }
}

async function runNeo4jExport(commandArgs) {
  if (commandArgs.length === 0 || commandArgs[0] === '--help' || commandArgs[0] === '-h') {
    printNeo4jHelp();
    process.exit(0);
  }

  const inputPath = commandArgs[0];
  const options = parseOptions(commandArgs.slice(1));

  // Validate required options individually
  const missing = [];
  if (!options['--uri']) missing.push('--uri');
  if (!options['--user']) missing.push('--user');
  if (!options['--password']) missing.push('--password');
  if (missing.length > 0) {
    throw new Error(`Missing required option(s): ${missing.join(', ')}\nRun 'bpmn2dexpi neo4j-export --help' for usage.`);
  }

  const uri = options['--uri'];
  const user = options['--user'];
  const password = options['--password'];
  const database = options['--database'] || 'neo4j';
  const forcedType = options['--input-type'];
  const dexpiOutPath = options['--dexpi-out'];

  // Validate --input-type value
  if (forcedType && forcedType !== 'bpmn' && forcedType !== 'dexpi') {
    throw new Error(`Invalid --input-type '${forcedType}'. Must be 'bpmn' or 'dexpi'.`);
  }

  const detected = detectInputType(inputPath);
  const inputType = forcedType || detected;
  if (inputType !== 'bpmn' && inputType !== 'dexpi') {
    throw new Error(`Cannot determine input type from '${inputPath}'. Use --input-type bpmn or --input-type dexpi.`);
  }

  const inputXml = readFileSync(inputPath, 'utf-8');
  let dexpiXml = inputXml;

  if (inputType === 'bpmn') {
    dexpiXml = await transformer.transform(inputXml);
    if (dexpiOutPath) {
      writeFileSync(dexpiOutPath, dexpiXml, 'utf-8');
      console.error(`✓ Saved transformed DEXPI XML to ${dexpiOutPath}`);
    }
  }

  const result = await exportToNeo4j(dexpiXml, {
    uri,
    user,
    password,
    database
  });

  if (!result.success) {
    throw new Error(result.message);
  }

  console.error(`✓ Neo4j export completed for ${inputPath}`);
  console.error(`✓ ${result.message}`);
}

async function main() {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  try {
    if (args[0] === 'neo4j-export') {
      await runNeo4jExport(args.slice(1));
    } else {
      const inputPath = args[0];
      const outputPath = args[1];
      await runTransform(inputPath, outputPath);
    }
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
