/**
 * Hides BPMN vocabulary that has no DEXPI Process mapping from the editor's
 * creation surfaces — the palette, the context pad's append actions, and the
 * morph ("change type") menu.
 *
 * Hidden, not blocked: gateways, intermediate/boundary throw-catch events,
 * data stores, and groups have no counterpart in the DEXPI Process
 * representation (splitting/mixing are ProcessStep classes, not gateways),
 * so offering them invites diagrams that silently don't export. Documents
 * that already contain such elements — e.g. BPMN imported from another tool
 * — still load, render, and can be edited or deleted; only the entry points
 * for creating NEW ones are removed. Pools/participants stay available.
 *
 * Implementation: reducer providers registered at LOW priority, so they run
 * after the default providers have contributed their entries and can filter
 * the accumulated set. This tracks upstream bpmn-js — entries added by
 * future versions pass through unless they match the hidden ids.
 */

const HIDDEN_PALETTE_ENTRIES = [
  'create.exclusive-gateway',
  'create.intermediate-event',
  'create.data-store',
  'create.group',
];

const HIDDEN_CONTEXT_PAD_ENTRIES = [
  'append.gateway',
  'append.intermediate-event',
];

/** Morph-menu targets outside the DEXPI subset. */
const HIDDEN_REPLACE_PATTERN = /gateway|intermediate|boundary|data-store/;

// Run after the default providers (priority 1000) so the reducer sees the
// full accumulated entry set.
const LOW_PRIORITY = 500;

type Entries = Record<string, unknown>;

function omit(entries: Entries, hidden: string[]): Entries {
  const out: Entries = { ...entries };
  for (const key of hidden) delete out[key];
  return out;
}

export default class DexpiSubsetFilter {
  static $inject = ['palette', 'contextPad', 'popupMenu'];

  constructor(palette: any, contextPad: any, popupMenu: any) {
    palette.registerProvider(LOW_PRIORITY, {
      getPaletteEntries: () => (entries: Entries) =>
        omit(entries, HIDDEN_PALETTE_ENTRIES),
    });

    contextPad.registerProvider(LOW_PRIORITY, {
      getContextPadEntries: () => (entries: Entries) =>
        omit(entries, HIDDEN_CONTEXT_PAD_ENTRIES),
    });

    popupMenu.registerProvider('bpmn-replace', LOW_PRIORITY, {
      getPopupMenuEntries: () => (entries: Entries) => {
        const out: Entries = {};
        for (const [id, entry] of Object.entries(entries)) {
          if (!HIDDEN_REPLACE_PATTERN.test(id)) out[id] = entry;
        }
        return out;
      },
    });
  }
}
