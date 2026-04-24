import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html>');
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Document = dom.window.Document;
global.Element = dom.window.Element;

const { readFileSync } = await import('fs');

// Dynamic imports after polyfill
const { DexpiToBpmnTransformer } = await import('./src/transformer/DexpiToBpmnTransformer.ts');

const xml = readFileSync('/tmp/minimal.xml', 'utf8');
const t = new DexpiToBpmnTransformer();
const out = t.transform(xml);
console.log('✓ Size:', out.length, 'chars');
const shapes = [...out.matchAll(/dc:Bounds/g)].length;
const tasks = [...out.matchAll(/bpmn:task /g)].length;
const types = [...new Set([...out.matchAll(/dexpiType="([^"]+)"/g)].map(m=>m[1]))];
console.log('Shapes:', shapes, '| Tasks:', tasks);
console.log('Types:', types.join(', '));
