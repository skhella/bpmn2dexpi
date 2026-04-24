// Test: does bpmn-js moddle parse anchorSide from dexpi:port XML attributes?
import { JSDOM } from 'jsdom';
const dom = new JSDOM('');
(global as any).DOMParser = dom.window.DOMParser;
(global as any).XMLSerializer = dom.window.XMLSerializer;
(global as any).document = dom.window.document;

import { readFileSync } from 'fs';

// Parse the TEP BPMN and check if anchorSide survives moddle parsing
// by looking at the raw XML first
const bpmn = readFileSync('./examples/Tennessee_Eastman_Process.bpmn', 'utf8');

// Check anchorSide in raw XML
const anchorMatches = [...bpmn.matchAll(/anchorSide="([^"]+)"/g)];
console.log(`\nanchorSide attributes in XML: ${anchorMatches.length}`);
anchorMatches.slice(0, 5).forEach(m => console.log(`  ${m[0]}`));

// Check anchorOffset  
const offsetMatches = [...bpmn.matchAll(/anchorOffset="([^"]+)"/g)];
console.log(`\nanchorOffset attributes in XML: ${offsetMatches.length}`);
offsetMatches.slice(0, 3).forEach(m => console.log(`  ${m[0]}`));

// Check if anchorSide is in dexpi.json moddle descriptor
const moddle = JSON.parse(readFileSync('./src/dexpi/moddle/dexpi.json', 'utf8'));
const portType = moddle.types?.find((t: any) => t.name === 'Port');
if (portType) {
  const anchorProp = portType.properties?.find((p: any) => p.name === 'anchorSide');
  console.log('\nanchorSide in moddle Port type:', anchorProp ? JSON.stringify(anchorProp) : 'NOT FOUND');
} else {
  console.log('\nPort type not found in moddle — looking at all types:');
  moddle.types?.forEach((t: any) => console.log(`  ${t.name}: ${t.properties?.map((p: any) => p.name).join(', ')}`));
}
