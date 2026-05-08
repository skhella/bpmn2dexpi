// Migrates a BPMN file's dexpi:Stream attributes from the legacy
// sourcePortRef/targetPortRef (suffix-only, e.g. "MO1_port") form to the
// new sourcePortId/targetPortId (full-id) form by combining the BPMN
// sequenceFlow's sourceRef/targetRef with the legacy suffix.
//
// Usage: node scripts/migrate_port_refs.mjs <file.bpmn>
//
// Idempotent: streams that already have sourcePortId/targetPortId are left alone.

import { readFileSync, writeFileSync } from 'fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/migrate_port_refs.mjs <file.bpmn>');
  process.exit(1);
}

const xml = readFileSync(path, 'utf-8');

// Match each <bpmn:sequenceFlow ...> ... </bpmn:sequenceFlow> as a unit, then
// inside that unit find the dexpi:Stream and rewrite its attributes.
const flowRe = /(<(?:bpmn:|bpmn2:)?sequenceFlow\b[^>]*?)(>[\s\S]*?)(<\/(?:bpmn:|bpmn2:)?sequenceFlow>)/g;
let migrations = 0;
let unchanged = 0;
const out = xml.replace(flowRe, (full, openTag, body, closeTag) => {
  // Pull sourceRef / targetRef from the open tag.
  const sourceRef = (openTag.match(/\bsourceRef\s*=\s*"([^"]+)"/) || [])[1];
  const targetRef = (openTag.match(/\btargetRef\s*=\s*"([^"]+)"/) || [])[1];
  if (!sourceRef || !targetRef) return full;

  // Find the dexpi:Stream inside the body. Match its open tag (self-closing
  // or paired); we only need to rewrite attributes so a single regex against
  // the open tag is enough.
  return openTag + body.replace(
    /<(dexpi:|)Stream\b([^>]*?)(\/?>)/,
    (streamTag, prefix, attrs, end) => {
      // Idempotency: skip if already migrated.
      if (/\bsourcePortId\s*=/.test(attrs) || /\btargetPortId\s*=/.test(attrs)) {
        unchanged++;
        return streamTag;
      }
      const sm = attrs.match(/\bsourcePortRef\s*=\s*"([^"]+)"/);
      const tm = attrs.match(/\btargetPortRef\s*=\s*"([^"]+)"/);
      if (!sm && !tm) {
        unchanged++;
        return streamTag;
      }
      let newAttrs = attrs;
      if (sm) {
        const fullId = `${sourceRef}_${sm[1]}`;
        newAttrs = newAttrs.replace(
          /\bsourcePortRef\s*=\s*"[^"]+"/,
          `sourcePortId="${fullId}"`,
        );
      }
      if (tm) {
        const fullId = `${targetRef}_${tm[1]}`;
        newAttrs = newAttrs.replace(
          /\btargetPortRef\s*=\s*"[^"]+"/,
          `targetPortId="${fullId}"`,
        );
      }
      migrations++;
      return `<${prefix}Stream${newAttrs}${end}`;
    },
  ) + closeTag;
});

if (migrations > 0) {
  writeFileSync(path, out);
}
console.log(`Migrated ${migrations} stream(s); left ${unchanged} unchanged.`);
