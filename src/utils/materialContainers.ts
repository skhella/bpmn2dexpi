/**
 * Content-based detection of the bpmn:DataObjectReference shapes that
 * carry DEXPI materials data. The transformer reads materials from
 * DataObjectReferences whose extensionElements contain dexpi:Material*
 * (and dexpi:Case for state grouping); identifying those containers
 * from the UI side by `businessObject.name === 'MaterialStates'` ties
 * the data model to a string the user can rename and is brittle in
 * BPMN files authored outside this tool. This helper finds them by
 * what they contain, not what they're called.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModdleVal = any;

const stripPrefix = (t: string | undefined): string =>
  typeof t === 'string' ? t.replace(/^dexpi:/i, '') : '';

const extensionValues = (el: ModdleVal): ModdleVal[] => {
  const values = el?.businessObject?.extensionElements?.values;
  return Array.isArray(values) ? values : [];
};

const valueMatches = (v: ModdleVal, names: ReadonlyArray<string>): boolean => {
  const t = stripPrefix(v?.$type);
  return names.includes(t);
};

const STATE_BEARING = ['MaterialState', 'Case'] as const;
const TEMPLATE_BEARING = ['MaterialTemplate', 'MaterialComponent'] as const;

/** True if `el` is a DataObjectReference whose extensionElements contain
 *  a MaterialState (directly) or a Case wrapping MaterialStates. */
export const isMaterialStatesContainer = (el: ModdleVal): boolean => {
  if (el?.type !== 'bpmn:DataObjectReference') return false;
  return extensionValues(el).some(v => valueMatches(v, STATE_BEARING));
};

/** True if `el` is a DataObjectReference whose extensionElements contain
 *  MaterialTemplate or MaterialComponent entries. */
export const isMaterialTemplatesContainer = (el: ModdleVal): boolean => {
  if (el?.type !== 'bpmn:DataObjectReference') return false;
  return extensionValues(el).some(v => valueMatches(v, TEMPLATE_BEARING));
};

/** Find the first MaterialStates-bearing DataObjectReference, or undefined. */
export const findMaterialStatesContainer = (elements: ModdleVal[]): ModdleVal | undefined =>
  elements.find(isMaterialStatesContainer);

/** Find the first MaterialTemplates-bearing DataObjectReference, or undefined. */
export const findMaterialTemplatesContainer = (elements: ModdleVal[]): ModdleVal | undefined =>
  elements.find(isMaterialTemplatesContainer);

/** All MaterialStates-bearing DataObjectReferences (multiple per Case grouping). */
export const findAllMaterialStatesContainers = (elements: ModdleVal[]): ModdleVal[] =>
  elements.filter(isMaterialStatesContainer);
