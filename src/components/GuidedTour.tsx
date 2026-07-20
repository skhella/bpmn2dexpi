/**
 * Interactive step-by-step tour.
 *
 * Walks a first-time user through building a minimal PFD — feed, one
 * classified process step with attributes, product — then the
 * instrumentation pattern (MeasuringProcessVariable task + named data
 * object wired through with data associations), and finally the full
 * fidelity round trip: strict mode on, Validate now, Generate Profile,
 * re-import, clean re-validation. Each step is a small bubble anchored
 * to the UI element it talks about (palette entry, properties-panel
 * dropdown, toolbar menu, dialogs, canvas).
 *
 * Action steps advance automatically: on every commandStack.changed the
 * current step's completion check runs against the element registry,
 * compared to a baseline captured once when the tour started — so the
 * tour also works on a canvas that already has content (e.g. the
 * Tennessee Eastman example), and steps the user already performed
 * ahead of time complete on entry. Note that AutoTypeBehavior stamps
 * every new task with the generic 'ProcessStep' type, so "classified"
 * here means "carries a specific class". Next/Back/Skip remain
 * available throughout; Escape exits.
 *
 * Positioning is imperative (refs + direct style writes, no state) so
 * bubbles track layout changes from selection/panel updates without
 * re-render churn.
 */
import { useEffect, useRef, useState } from 'react';

interface GuidedTourProps {
  active: boolean;
  modeler: any | null;
  onExit: () => void;
}

type Placement = 'right' | 'left' | 'top' | 'bottom';

interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selectors tried in order; first match anchors the bubble. */
  targets: string[];
  placement: Placement;
  /**
   * Structural completion check for auto-advance. Receives the element
   * registry and the baseline snapshot captured at tour start. Absent on
   * purely informational steps (manual Next).
   */
  isDone?: (registry: any, baseline: Baseline) => boolean;
  /**
   * DOM-state completion check for steps whose outcome lives outside the
   * model (a dialog opened, a toggle switched, a toast shown). Evaluated
   * on entry, on model changes, and on document mutations.
   */
  isDoneDom?: () => boolean;
  /**
   * Dynamic anchor: consulted where the targets array contains the
   * '@@resolve' token — lets a step ring a concrete diagram shape (via
   * its SVG graphics) that has no static CSS selector.
   */
  resolveTarget?: (modeler: any) => Element | null;
}

interface Baseline {
  counts: Record<string, number>;
  /** Tasks that already carried a specific (non-generic) class. */
  specificIds: Set<string>;
  measuringIds: Set<string>;
  namedDataObjectIds: Set<string>;
  wiredDataObjectIds: Set<string>;
}

const dexpiTypeOf = (el: any): string => {
  const vals = el?.businessObject?.extensionElements?.values;
  if (!Array.isArray(vals)) return '';
  const de = vals.find((v: any) => v.$type === 'dexpi:Element');
  return de?.dexpiType || de?.type || '';
};

const countType = (registry: any, type: string): number =>
  registry.getAll().filter((e: any) => e.type === type).length;

const idsWhere = (registry: any, pred: (e: any) => boolean): Set<string> =>
  new Set(registry.getAll().filter(pred).map((e: any) => e.id));

const TASK_TYPES = ['bpmn:Task', 'bpmn:ServiceTask', 'bpmn:UserTask', 'bpmn:CallActivity'];

const isTask = (e: any): boolean => TASK_TYPES.includes(e.type);

/** Ids of data objects with >= 2 attached data associations. */
const wiredDataObjectIds = (registry: any): Set<string> => {
  const per = new Map<string, number>();
  registry.getAll().forEach((e: any) => {
    if (e.type === 'bpmn:DataInputAssociation' || e.type === 'bpmn:DataOutputAssociation') {
      [e.source, e.target].forEach((n: any) => {
        if (n?.type === 'bpmn:DataObjectReference') {
          per.set(n.id, (per.get(n.id) || 0) + 1);
        }
      });
    }
  });
  return new Set(Array.from(per.entries()).filter(([, c]) => c >= 2).map(([id]) => id));
};

/** New tasks are auto-stamped with the generic 'ProcessStep' type by
 *  AutoTypeBehavior — only a more specific class counts as classified. */
const hasSpecificClass = (e: any): boolean => {
  const t = dexpiTypeOf(e);
  return t !== '' && t !== 'ProcessStep';
};

const captureBaseline = (registry: any): Baseline => ({
  counts: {
    'bpmn:StartEvent': countType(registry, 'bpmn:StartEvent'),
    'bpmn:EndEvent': countType(registry, 'bpmn:EndEvent'),
    'bpmn:SequenceFlow': countType(registry, 'bpmn:SequenceFlow'),
    'bpmn:DataObjectReference': countType(registry, 'bpmn:DataObjectReference'),
    task: registry.getAll().filter(isTask).length,
  },
  specificIds: idsWhere(registry, (e) => isTask(e) && hasSpecificClass(e)),
  measuringIds: idsWhere(registry, (e) => isTask(e) && dexpiTypeOf(e) === 'MeasuringProcessVariable'),
  namedDataObjectIds: idsWhere(
    registry,
    (e) => e.type === 'bpmn:DataObjectReference' && !!e.businessObject?.name
  ),
  wiredDataObjectIds: new Set<string>(),
});

/** Count grew by at least `by` since the tour-start baseline. */
const grewBy = (registry: any, baseline: Baseline, key: string, by: number): boolean => {
  const now = key === 'task' ? registry.getAll().filter(isTask).length : countType(registry, key);
  return now >= baseline.counts[key] + by;
};

const STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to the tour',
    body:
      'We will build a tiny PFD together: a feed, one process step and a product, ' +
      'then measure a variable on the step and export DEXPI 2.0 XML. ' +
      'The palette on the left holds every element you need. ' +
      'You can stop any time with the x above or the Esc key.',
    targets: ['.djs-palette'],
    placement: 'right',
  },
  {
    id: 'start-event',
    title: 'Add the feed (Source)',
    body:
      'Drag the thin circle (start event) from the palette onto the canvas. ' +
      'Start events are exported as DEXPI Sources — one per feed.',
    targets: ['.djs-palette .entry[data-action="create.start-event"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => grewBy(r, b, 'bpmn:StartEvent', 1),
  },
  {
    id: 'task',
    title: 'Add a process step',
    body:
      'Drag the rectangle (task) onto the canvas, to the right of the feed. ' +
      'Tasks are exported as DEXPI ProcessSteps.',
    targets: ['.djs-palette .entry[data-action="create.task"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => grewBy(r, b, 'task', 1),
  },
  {
    id: 'classify',
    title: 'Choose its DEXPI class',
    body:
      'Click the task, then open the DEXPI Type dropdown in the right-hand panel ' +
      'and pick a specific class, for example Mixing. ' +
      'New tasks start as the generic ProcessStep; the specific class determines ' +
      'the properties and ports the step carries in the export. ' +
      'Nothing here is hard-coded: the class, unit, and enumeration dropdowns ' +
      'throughout the app are built dynamically from the official DEXPI 2.0 ' +
      'schema release.',
    targets: ['[data-tour="dexpi-type-select"]', '.properties-panel'],
    placement: 'left',
    isDone: (r, b) =>
      r.getAll().some((e: any) => isTask(e) && !b.specificIds.has(e.id) && hasSpecificClass(e)),
  },
  {
    id: 'attributes',
    title: 'Fill in its properties',
    body:
      'Below the type, the panel lists the properties of the chosen class — ' +
      'placeholders appear for what the class (or a loaded Profile) requires; fill ' +
      'the ones you know. You can also press Add Attribute for a project-specific ' +
      'property, for example DesignMargin with any value. Custom names go beyond ' +
      'the standard vocabulary — they export as extensions, and later in this ' +
      'tour strict validation will find them and a Profile will legitimize them. ' +
      'Press Next when you are done here.',
    targets: ['[data-tour="add-attribute"]', '.properties-panel'],
    placement: 'left',
  },
  {
    id: 'end-event',
    title: 'Add the product (Sink)',
    body:
      'Drag the thick circle (end event) onto the canvas after the step. ' +
      'End events are exported as DEXPI Sinks.',
    targets: ['.djs-palette .entry[data-action="create.end-event"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => grewBy(r, b, 'bpmn:EndEvent', 1),
  },
  {
    id: 'connect',
    title: 'Connect with streams',
    body:
      'Click the feed, then drag the connection arrow from its context menu onto the step; ' +
      'then connect the step to the product the same way. ' +
      'Each sequence flow becomes a DEXPI Stream, and typed ports (MI1, MO1, …) ' +
      'are created on both ends automatically.',
    targets: ['.canvas-container'],
    placement: 'top',
    isDone: (r, b) => grewBy(r, b, 'bpmn:SequenceFlow', 2),
  },
  {
    id: 'ports',
    title: 'See the ports',
    body:
      'Toggle Ports in the toolbar to display the material ports the flows just created. ' +
      'Toggle again to hide them — they stay in the model either way.',
    targets: ['[data-tour="ports-toggle"]'],
    placement: 'bottom',
  },
  {
    id: 'instr-task',
    title: 'Now the instrumentation',
    body:
      'Instrumentation is modeled as its own small task. ' +
      'Drag one more task onto the canvas, above the process step — ' +
      'it will be the measuring instrument, not a process step.',
    targets: ['.djs-palette .entry[data-action="create.task"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => grewBy(r, b, 'task', 2),
  },
  {
    id: 'instr-class',
    title: 'Make it a MeasuringProcessVariable',
    body:
      'Click the new task and set its DEXPI Type to MeasuringProcessVariable — ' +
      'the DEXPI class for a measuring activity. ' +
      'ControllingProcessVariable and ConveyingSignal work the same way.',
    targets: ['[data-tour="dexpi-type-select"]', '.properties-panel'],
    placement: 'left',
    isDone: (r, b) =>
      r
        .getAll()
        .some(
          (e: any) =>
            isTask(e) && !b.measuringIds.has(e.id) && dexpiTypeOf(e) === 'MeasuringProcessVariable'
        ),
  },
  {
    id: 'data-object',
    title: 'Add the variable carrier',
    body:
      'Drag a data object onto the canvas between the instrument and the process step. ' +
      'In DEXPI Process the measured value travels as information — ' +
      'the data object stands for that variable.',
    targets: ['.djs-palette .entry[data-action="create.data-object"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => grewBy(r, b, 'bpmn:DataObjectReference', 1),
  },
  {
    id: 'wire',
    title: 'Wire it through',
    body:
      'The highlighted page-like shape is your data object. Click the instrument task ' +
      'and drag its connection arrow onto it — the link appears dashed (a data ' +
      'association). Then click the data object and drag its connection arrow onto the ' +
      'process step being measured or controlled. This instrument-variable-step chain ' +
      'is what the exporter reads: the variable becomes a Core/QualifiedValue parameter ' +
      'slot on the measured step, and the instrument receives a ProcessStepReference ' +
      'and a MeasuredVariableReference.',
    targets: ['@@resolve', '.canvas-container'],
    placement: 'right',
    resolveTarget: (modeler: any) => {
      const registry = modeler.get('elementRegistry');
      const candidates = registry
        .getAll()
        .filter((e: any) => e.type === 'bpmn:DataObjectReference' && !e.businessObject?.name);
      const el = candidates[candidates.length - 1];
      return el ? (registry.getGraphics(el) as Element) : null;
    },
    isDone: (r, b) =>
      Array.from(wiredDataObjectIds(r)).some((id) => !b.wiredDataObjectIds.has(id)),
  },
  {
    id: 'name-variable',
    title: 'Pick the variable',
    body:
      'Click the highlighted data object (the page-like shape between instrument and ' +
      'step) — its panel shows the Process Variable editor. Pick the variable from the ' +
      'dropdown, for example Temperature. The choices are the variable properties the ' +
      'DEXPI 2.0 schema declares on the connected step class; a custom name exports as ' +
      'an extension, which strict validation will flag and a Profile can declare.',
    targets: ['#dop-property', '@@resolve', '.properties-panel'],
    placement: 'left',
    resolveTarget: (modeler: any) => {
      const registry = modeler.get('elementRegistry');
      const candidates = registry
        .getAll()
        .filter((e: any) => e.type === 'bpmn:DataObjectReference' && !e.businessObject?.name);
      const el = candidates[candidates.length - 1];
      return el ? (registry.getGraphics(el) as Element) : null;
    },
    isDone: (r, b) =>
      r
        .getAll()
        .some(
          (e: any) =>
            e.type === 'bpmn:DataObjectReference' &&
            !b.namedDataObjectIds.has(e.id) &&
            !!e.businessObject?.name
        ),
  },
  {
    id: 'strict',
    title: 'Turn on Strict mode',
    body:
      'Open the DEXPI menu in the toolbar and switch on Strict property-name ' +
      'validation. Beyond the XSD check that runs on every export, strict adds five ' +
      'information-model checks: property names and kinds, data types, reference ' +
      'targets, cardinality, and class existence. Findings are warnings — your ' +
      'export is never blocked.',
    targets: ['[data-tour="strict-toggle"]', '[data-tour="dexpi-menu"]'],
    placement: 'left',
    isDoneDom: () =>
      (document.querySelector('[data-tour="strict-toggle"]') as HTMLInputElement | null)
        ?.checked === true,
  },
  {
    id: 'validate-now',
    title: 'Validate without exporting',
    body:
      'Click Validate now in the same menu — the five checks run on the current ' +
      'model without downloading anything. If you added a custom attribute earlier, ' +
      'it shows up as a finding: strict points at exactly where your model extends ' +
      'the standard. A fully standard model gets a green all-clear instead — ' +
      'in that case skip ahead with Next.',
    targets: ['[data-tour="validate-now"]', '[data-tour="dexpi-menu"]'],
    placement: 'left',
    isDoneDom: () => !!document.getElementById('strict-warning-title'),
  },
  {
    id: 'generate-profile',
    title: 'Generate a Profile',
    body:
      'Click Generate Profile in the findings dialog (it is also in the DEXPI ' +
      'menu). A DEXPI Profile is an XML file that declares your project-specific ' +
      'classes and properties, so that strict validation — here or in a partner ' +
      'tool — accepts them as declared vocabulary instead of unknowns.',
    targets: ['[data-tour="generate-profile"]', '[data-tour="generate-profile-menu"]', '[data-tour="dexpi-menu"]'],
    placement: 'bottom',
    isDoneDom: () => !!document.getElementById('profile-export-dialog-title'),
  },
  {
    id: 'profile-download',
    title: 'Download the Profile',
    body:
      'Confirm with Generate — the Profile XML downloads. This file is the ' +
      'shareable artifact: send it to a project partner and their session will ' +
      'validate models against your vocabulary too.',
    targets: ['[data-tour="profile-generate-confirm"]'],
    placement: 'left',
    isDoneDom: () => !document.getElementById('profile-export-dialog-title'),
  },
  {
    id: 'import-profile',
    title: 'Import it back',
    body:
      'Open the DEXPI menu again, click Import Profile, and pick the file you ' +
      'just downloaded. Profiles are per-session, so after a page reload you ' +
      'would import again. The green confirmation means this session now ' +
      'accepts your project vocabulary.',
    targets: ['[data-tour="import-profile"]', '[data-tour="dexpi-menu"]'],
    placement: 'left',
    isDoneDom: () => (document.body.textContent || '').includes('loaded (per-session)'),
  },
  {
    id: 'round-trip',
    title: 'Round trip complete',
    body:
      'Run Validate now once more — the findings are gone: standard plus Profile ' +
      'now fully describe your model. Export DEXPI XML ships it validated against ' +
      'the official DEXPI 2.0 XML Schema. That is the whole loop — draw, classify, ' +
      'wire, validate, close the gaps with a Profile, exchange.',
    targets: ['[data-tour="export-dexpi"]'],
    placement: 'bottom',
  },
];

const BUBBLE_WIDTH = 320;
const GAP = 14;

export function GuidedTour({ active, modeler: modelerProp, onExit }: GuidedTourProps) {
  // Fall back to the debug handle so the tour survives states where the
  // prop is null or stale (e.g. an HMR remount in dev).
  const modeler = modelerProp ?? (window as any).__bpmn_modeler__ ?? null;
  const [stepIndex, setStepIndex] = useState(0);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const baselineRef = useRef<Baseline | null>(null);
  const navRef = useRef<'auto' | 'back'>('auto');
  // Set while the user has manually dragged the bubble (cleared per step).
  const draggedRef = useRef<{ left: number; top: number } | null>(null);

  // Rewind to the first step whenever a new tour begins (setState during
  // render is React's sanctioned derived-state adjustment pattern).
  const [prevActive, setPrevActive] = useState(active);
  if (active !== prevActive) {
    setPrevActive(active);
    if (active && stepIndex !== 0) setStepIndex(0);
  }

  const step = STEPS[stepIndex];

  // A manual bubble position applies to the step it was dragged on; the
  // next step re-anchors to its own target.
  useEffect(() => {
    draggedRef.current = null;
  }, [stepIndex]);

  // Drag the bubble by its header: record the pointer offset on mousedown,
  // follow the pointer with direct style writes, and remember the final
  // spot so position() stops re-anchoring for this step.
  const startBubbleDrag = (e: React.MouseEvent) => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    e.preventDefault();
    const rect = bubble.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const onMove = (ev: MouseEvent) => {
      const left = ev.clientX - offsetX;
      const top = ev.clientY - offsetY;
      draggedRef.current = { left, top };
      bubble.style.left = `${Math.max(8, Math.min(left, window.innerWidth - BUBBLE_WIDTH - 8))}px`;
      bubble.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bubble.offsetHeight - 8))}px`;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── positioning (imperative: no state writes) ──────────────────────────
  useEffect(() => {
    if (!active) return;

    const findTarget = (current: TourStep): Element | null => {
      for (const sel of current.targets) {
        const hit =
          sel === '@@resolve'
            ? (modeler && current.resolveTarget ? current.resolveTarget(modeler) : null)
            : document.querySelector(sel);
        if (hit) return hit;
      }
      return null;
    };

    const position = () => {
      const bubble = bubbleRef.current;
      const ring = ringRef.current;
      if (!bubble) return;
      const current = STEPS[stepIndex];
      const target: Element | null = findTarget(current);

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bh = bubble.offsetHeight || 180;
      let left: number;
      let top: number;

      // Once the user has dragged the bubble, keep it where they put it
      // for the rest of this step (the ring keeps tracking the target).
      if (draggedRef.current) {
        const d = draggedRef.current;
        bubble.style.left = `${Math.max(8, Math.min(d.left, vw - BUBBLE_WIDTH - 8))}px`;
        bubble.style.top = `${Math.max(8, Math.min(d.top, vh - bh - 8))}px`;
        if (ring) {
          const ringTarget = findTarget(current);
          if (ringTarget) {
            const rect = ringTarget.getBoundingClientRect();
            ring.style.display = 'block';
            ring.style.left = `${rect.left - 5}px`;
            ring.style.top = `${rect.top - 5}px`;
            ring.style.width = `${rect.width + 10}px`;
            ring.style.height = `${rect.height + 10}px`;
          } else {
            ring.style.display = 'none';
          }
        }
        return;
      }

      if (target) {
        const rect = target.getBoundingClientRect();
        if (ring) {
          ring.style.display = 'block';
          ring.style.left = `${rect.left - 5}px`;
          ring.style.top = `${rect.top - 5}px`;
          ring.style.width = `${rect.width + 10}px`;
          ring.style.height = `${rect.height + 10}px`;
        }
        switch (current.placement) {
          case 'right':
            left = rect.right + GAP;
            top = rect.top + rect.height / 2 - bh / 2;
            break;
          case 'left':
            left = rect.left - BUBBLE_WIDTH - GAP;
            top = rect.top + rect.height / 2 - bh / 2;
            break;
          case 'bottom':
            left = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2;
            top = rect.bottom + GAP;
            break;
          case 'top':
          default:
            // Anchored to large targets (the canvas): sit just inside the
            // bottom edge — modeling usually happens in the upper half, so
            // the bubble stays out of the way (and it can be dragged).
            if (rect.height > vh / 2) {
              left = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2;
              top = rect.bottom - bh - GAP;
            } else {
              left = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2;
              top = rect.top - bh - GAP;
            }
            break;
        }
      } else {
        if (ring) ring.style.display = 'none';
        left = vw / 2 - BUBBLE_WIDTH / 2;
        top = vh / 3;
      }

      left = Math.max(8, Math.min(left, vw - BUBBLE_WIDTH - 8));
      top = Math.max(8, Math.min(top, vh - bh - 8));
      bubble.style.left = `${left}px`;
      bubble.style.top = `${top}px`;
    };

    position();
    window.addEventListener('resize', position);
    const observer = new ResizeObserver(position);
    observer.observe(document.body);
    // Panels, menus, and dialogs render their content after the step that
    // points at them becomes active — watch the document so the ring lands
    // on late-appearing targets instead of staying on a fallback. childList
    // only: position() writes style attributes, which this config ignores,
    // so repositioning cannot re-trigger the observer.
    const mutations = new MutationObserver(position);
    mutations.observe(document.body, { childList: true, subtree: true });

    let eventBus: any = null;
    if (modeler) {
      eventBus = modeler.get('eventBus');
      eventBus.on('commandStack.changed', position);
      eventBus.on('selection.changed', position);
    }
    return () => {
      window.removeEventListener('resize', position);
      observer.disconnect();
      mutations.disconnect();
      if (eventBus) {
        eventBus.off('commandStack.changed', position);
        eventBus.off('selection.changed', position);
      }
    };
  }, [active, stepIndex, modeler]);

  // ── baseline capture (once per tour) + auto-advance ────────────────────
  useEffect(() => {
    if (!active) {
      baselineRef.current = null;
      return;
    }
    if (!modeler) return;
    const registry = modeler.get('elementRegistry');
    if (!baselineRef.current) {
      const baseline = captureBaseline(registry);
      // The wire step compares against objects already fully wired at tour
      // start (relevant when the example diagram is loaded).
      baseline.wiredDataObjectIds = wiredDataObjectIds(registry);
      baselineRef.current = baseline;
    }

    const current = STEPS[stepIndex];
    const eventBus = modeler.get('eventBus');
    // New / load / import replaces the diagram without commandStack events
    // and invalidates the counts captured at tour start — re-baseline, or
    // nothing created afterwards could ever satisfy a stale threshold.
    const rebaseline = () => {
      const fresh = captureBaseline(registry);
      fresh.wiredDataObjectIds = wiredDataObjectIds(registry);
      baselineRef.current = fresh;
    };
    eventBus.on('import.done', rebaseline);

    if (!current.isDone && !current.isDoneDom) {
      return () => eventBus.off('import.done', rebaseline);
    }

    const check = () => {
      const baseline = baselineRef.current;
      if (!baseline) return;
      const done =
        (current.isDone ? current.isDone(registry, baseline) : false) ||
        (current.isDoneDom ? current.isDoneDom() : false);
      if (done) {
        setStepIndex((i) => (i === stepIndex ? Math.min(i + 1, STEPS.length - 1) : i));
      }
    };
    // Steps the user already performed complete on entry — unless the user
    // navigated Back to reread one; then only a fresh edit advances.
    if (navRef.current !== 'back') check();
    navRef.current = 'auto';
    eventBus.on('commandStack.changed', check);
    // DOM conditions (dialog opened, toggle switched, toast shown) don't
    // touch the command stack — watch the document for them.
    let domWatch: MutationObserver | null = null;
    if (current.isDoneDom) {
      domWatch = new MutationObserver(check);
      domWatch.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      eventBus.off('commandStack.changed', check);
      eventBus.off('import.done', rebaseline);
      domWatch?.disconnect();
    };
  }, [active, stepIndex, modeler]);

  // ── escape to exit ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onExit]);

  if (!active) return null;

  const last = stepIndex === STEPS.length - 1;

  return (
    <>
      <div
        ref={ringRef}
        style={{
          position: 'fixed',
          zIndex: 1199,
          pointerEvents: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          border: '2px solid #3498db',
          borderRadius: '8px',
          boxShadow: '0 0 0 4px rgba(52, 152, 219, 0.2)',
          transition: 'all 0.15s ease',
        }}
      />
      <div
        ref={bubbleRef}
        role="dialog"
        aria-label={step.title}
        style={{
          position: 'fixed',
          zIndex: 1200,
          width: `${BUBBLE_WIDTH}px`,
          boxSizing: 'border-box',
          background: '#fff',
          color: '#222',
          border: '1px solid #ccd4d8',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          padding: '0.8em 1em',
          fontSize: '0.88rem',
          lineHeight: 1.45,
          // Selectable bubble text lets Safari anchor a page-wide text
          // selection when a palette drag sweeps across it — keep the tour
          // chrome unselectable.
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <div
          onMouseDown={startBubbleDrag}
          title="Drag to move this bubble"
          style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5em', cursor: 'move' }}
        >
          <strong style={{ fontSize: '0.95rem' }}>{step.title}</strong>
          <button
            onClick={onExit}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Exit tour"
            title="Exit tour"
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: '#888',
              fontSize: '1rem',
              lineHeight: 1,
              padding: '0 0 0 0.4em',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ marginTop: '0.45em', color: '#444' }}>{step.body}</div>
        {step.isDone && (
          <div style={{ marginTop: '0.45em', fontSize: '0.78rem', color: '#3498db' }}>
            This step advances by itself once done — or use Next.
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: '0.7em',
            gap: '0.5em',
          }}
        >
          <button
            className="btn"
            onClick={() => {
              navRef.current = 'back';
              setStepIndex((i) => Math.max(0, i - 1));
            }}
            disabled={stepIndex === 0}
            style={{ fontSize: '0.8em', padding: '0.25rem 0.6rem' }}
          >
            Back
          </button>
          <span style={{ fontSize: '0.78rem', color: '#888' }}>
            {stepIndex + 1} / {STEPS.length}
          </span>
          <button
            className="btn btn-primary"
            onClick={() => (last ? onExit() : setStepIndex((i) => Math.min(i + 1, STEPS.length - 1)))}
            style={{ fontSize: '0.8em', padding: '0.25rem 0.6rem' }}
          >
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );
}
