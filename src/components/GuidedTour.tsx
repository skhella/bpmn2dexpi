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
  /** One muted line on what the step means in DEXPI terms. */
  why?: string;
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
  /** Element ids present when the tour (or a diagram replacement) started —
   *  completion checks look for elements NOT in these sets, so deleting
   *  and re-adding elements can never strand a step the way count
   *  thresholds could. */
  startEventIds: Set<string>;
  endEventIds: Set<string>;
  taskIds: Set<string>;
  flowIds: Set<string>;
  dataObjectIds: Set<string>;
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
  startEventIds: idsWhere(registry, (e) => e.type === 'bpmn:StartEvent'),
  endEventIds: idsWhere(registry, (e) => e.type === 'bpmn:EndEvent'),
  taskIds: idsWhere(registry, isTask),
  flowIds: idsWhere(registry, (e) => e.type === 'bpmn:SequenceFlow'),
  dataObjectIds: idsWhere(registry, (e) => e.type === 'bpmn:DataObjectReference'),
  specificIds: idsWhere(registry, (e) => isTask(e) && hasSpecificClass(e)),
  measuringIds: idsWhere(registry, (e) => isTask(e) && dexpiTypeOf(e) === 'MeasuringProcessVariable'),
  namedDataObjectIds: idsWhere(
    registry,
    (e) => e.type === 'bpmn:DataObjectReference' && !!e.businessObject?.name
  ),
  wiredDataObjectIds: new Set<string>(),
});

/** Elements matching `pred` that were not present at the baseline. */
const newSince = (registry: any, baseIds: Set<string>, pred: (e: any) => boolean): any[] =>
  registry.getAll().filter((e: any) => pred(e) && !baseIds.has(e.id));

const STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    body: 'A feed, one process step and a product; then a measurement; then export. The palette on the left has everything. Esc leaves the tour.',
    targets: ['.djs-palette'],
    placement: 'right',
  },
  {
    id: 'start-event',
    title: 'Add the feed',
    body: 'Drag the thin circle onto the canvas.',
    why: 'A start event becomes a DEXPI Source, one per feed.',
    targets: ['.djs-palette .entry[data-action="create.start-event"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => newSince(r, b.startEventIds, (e) => e.type === 'bpmn:StartEvent').length >= 1,
  },
  {
    id: 'task',
    title: 'Add a process step',
    body: 'Drag the rectangle onto the canvas, right of the feed.',
    why: 'A task becomes a DEXPI ProcessStep.',
    targets: ['.djs-palette .entry[data-action="create.task"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => newSince(r, b.taskIds, isTask).length >= 1,
  },
  {
    id: 'classify',
    title: 'Give it a class',
    body: 'Click the task and pick a class in the DEXPI Type dropdown, for example Mixing.',
    why: 'The class decides which properties and ports the step carries. The lists come straight from the DEXPI 2.0 model.',
    targets: ['[data-tour="dexpi-type-select"]', '.properties-panel'],
    placement: 'left',
    isDone: (r, b) =>
      r.getAll().some((e: any) => isTask(e) && !b.specificIds.has(e.id) && hasSpecificClass(e)),
  },
  {
    id: 'attributes',
    title: 'Fill in what you know',
    body: 'Set the properties below the type. Add Attribute adds a project-specific one, for example DesignMargin. Press Next when done.',
    why: 'Custom names export as extensions; a Profile will declare them later in this tour.',
    targets: ['[data-tour="add-attribute"]', '.properties-panel'],
    placement: 'left',
  },
  {
    id: 'end-event',
    title: 'Add the product',
    body: 'Drag the thick circle after the step.',
    why: 'An end event becomes a DEXPI Sink.',
    targets: ['.djs-palette .entry[data-action="create.end-event"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => newSince(r, b.endEventIds, (e) => e.type === 'bpmn:EndEvent').length >= 1,
  },
  {
    id: 'connect',
    title: 'Connect them',
    body: 'Click the feed and drag its arrow onto the step; then the step onto the product.',
    why: 'Each flow becomes a Stream, with a material port created on both ends.',
    targets: ['.canvas-container'],
    placement: 'top',
    isDone: (r, b) => newSince(r, b.flowIds, (e) => e.type === 'bpmn:SequenceFlow').length >= 2,
  },
  {
    id: 'ports',
    title: 'See the ports',
    body: 'Toggle Ports in the toolbar; toggle again to hide them.',
    why: 'They stay in the model either way.',
    targets: ['[data-tour="ports-toggle"]'],
    placement: 'bottom',
  },
  {
    id: 'instr-task',
    title: 'Add an instrument',
    body: 'Drag one more task above the process step.',
    why: 'An instrument is modelled as its own small task.',
    targets: ['.djs-palette .entry[data-action="create.task"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => newSince(r, b.taskIds, isTask).some((e: any) => !hasSpecificClass(e)),
  },
  {
    id: 'instr-class',
    title: 'Make it a measurement',
    body: 'Click it and set its DEXPI Type to MeasuringProcessVariable.',
    why: 'ControllingProcessVariable and ConveyingSignal work the same way.',
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
    title: 'Add the variable',
    body: 'Drag a data object between the instrument and the step.',
    why: 'It stands for the measured variable.',
    targets: ['.djs-palette .entry[data-action="create.data-object"]', '.djs-palette'],
    placement: 'right',
    isDone: (r, b) => newSince(r, b.dataObjectIds, (e) => e.type === 'bpmn:DataObjectReference').length >= 1,
  },
  {
    id: 'wire',
    title: 'Wire it through',
    body: 'Drag the instrument\'s arrow onto the data object, then the data object\'s arrow onto the step.',
    why: 'Instrument, variable, step: that chain is what the export reads. The variable becomes a parameter on the step, referenced by the instrument.',
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
    body: 'Click the data object and choose the variable, for example Temperature.',
    why: 'The list is what DEXPI defines for this step class. Custom is an extension until a Profile declares it.',
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
    body: 'Open the DEXPI menu and switch on Strict validation.',
    why: 'Five information-model checks on top of the XSD. Findings never block an export.',
    targets: ['[data-tour="strict-toggle"]', '[data-tour="dexpi-menu"]'],
    placement: 'left',
    isDoneDom: () =>
      (document.querySelector('[data-tour="strict-toggle"]') as HTMLInputElement | null)
        ?.checked === true,
  },
  {
    id: 'validate-now',
    title: 'Validate',
    body: 'Click Validate now in the same menu.',
    why: 'Your custom attribute shows up as a finding. All green? Press Next.',
    targets: ['[data-tour="validate-now"]', '[data-tour="dexpi-menu"]'],
    placement: 'left',
    isDoneDom: () => !!document.getElementById('strict-warning-title'),
  },
  {
    id: 'generate-profile',
    title: 'Generate a Profile',
    body: 'Click Generate Profile in the findings dialog.',
    why: 'A Profile is a small DEXPI model that declares your project vocabulary.',
    targets: ['[data-tour="generate-profile"]', '[data-tour="generate-profile-menu"]', '[data-tour="dexpi-menu"]'],
    placement: 'bottom',
    isDoneDom: () => !!document.getElementById('profile-export-dialog-title'),
  },
  {
    id: 'profile-download',
    title: 'Download it',
    body: 'Confirm with Generate; the Profile downloads.',
    why: 'Share it and a partner\'s tool validates against your vocabulary too.',
    targets: ['[data-tour="profile-generate-confirm"]'],
    placement: 'left',
    isDoneDom: () => !document.getElementById('profile-export-dialog-title'),
  },
  {
    id: 'import-profile',
    title: 'Import it back',
    body: 'DEXPI menu, Import Profile, pick the file you just downloaded.',
    why: 'Profiles live per session; import again after a reload.',
    targets: ['[data-tour="import-profile"]', '[data-tour="dexpi-menu"]'],
    placement: 'left',
    isDoneDom: () => (document.body.textContent || '').includes('loaded (per-session)'),
  },
  {
    id: 'round-trip',
    title: 'Done',
    body: 'Run Validate now again: the findings are gone. Export DEXPI XML ships it.',
    why: 'Draw, classify, wire, validate, declare, exchange.',
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
        // Anchors on the canvas (the canvas itself or a diagram shape):
        // park the bubble at the canvas's top-right, next to the panel —
        // never over the modeling area. The ring keeps marking the anchor.
        const canvasEl = document.querySelector('.canvas-container');
        if (canvasEl && (target === canvasEl || canvasEl.contains(target))) {
          const c = canvasEl.getBoundingClientRect();
          left = c.right - BUBBLE_WIDTH - GAP;
          top = c.top + GAP;
          left = Math.max(8, Math.min(left, vw - BUBBLE_WIDTH - 8));
          top = Math.max(8, Math.min(top, vh - bh - 8));
          bubble.style.left = `${left}px`;
          bubble.style.top = `${top}px`;
          return;
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
            left = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2;
            top = rect.top - bh - GAP;
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
        <div aria-hidden="true" style={{ height: '3px', borderRadius: '2px', background: '#E2E8F0', marginBottom: '0.6em', overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(((stepIndex + 1) / STEPS.length) * 100)}%`, height: '100%', background: '#0E7490', transition: 'width .25s' }} />
        </div>
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
        <div style={{ marginTop: '0.45em', color: '#222' }}>{step.body}</div>
        {step.why && (
          <div style={{ marginTop: '0.35em', fontSize: '0.8rem', color: '#64748B', lineHeight: 1.4 }}>{step.why}</div>
        )}
        {step.isDone && (
          <div style={{ marginTop: '0.45em', fontSize: '0.78rem', color: '#3498db' }}>
            Advances by itself when done.
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
