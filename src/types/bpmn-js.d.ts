/**
 * Type declarations for bpmn-js internals.
 * bpmn-js does not ship TypeScript definitions, so we declare the shapes
 * we interact with here. These are structural (duck-typed) interfaces —
 * they describe the subset of the API we actually use.
 */

// ── BPMN Business Objects (moddle) ──────────────────────────────────────────

export interface BpmnExtensionElements {
  values?: BpmnModdleElement[];
  $type?: string;
}

export interface BpmnBusinessObject {
  id: string;
  name?: string;
  $type: string;
  extensionElements?: BpmnExtensionElements;
  flowElements?: BpmnBusinessObject[];
  sourceRef?: BpmnBusinessObject;
  targetRef?: BpmnBusinessObject;
  dataOutputAssociations?: BpmnBusinessObject[];
  dataInputAssociations?: BpmnBusinessObject[];
  [key: string]: unknown;
}

export interface BpmnModdleElement {
  $type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- moddle elements have dynamic properties set by bpmn-js
  [key: string]: any;
}

// ── Diagram Elements ─────────────────────────────────────────────────────────

export interface BpmnElement {
  id: string;
  type: string;
  businessObject: BpmnBusinessObject;
  parent?: BpmnElement;
  children?: BpmnElement[];
  waypoints?: Array<{ x: number; y: number }>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  source?: BpmnElement;
  target?: BpmnElement;
  [key: string]: unknown;
}

export interface BpmnConnection extends BpmnElement {
  waypoints: Array<{ x: number; y: number }>;
  source: BpmnElement;
  target: BpmnElement;
}

// ── bpmn-js Services ─────────────────────────────────────────────────────────

export interface BpmnEventBus {
  on(event: string, callback: (event: BpmnEvent) => void): void;
  on(event: string, priority: number, callback: (event: BpmnEvent) => void): void;
  off(event: string, callback: (event: BpmnEvent) => void): void;
  fire(event: string, data?: unknown): void;
}

export interface BpmnEvent {
  element?: BpmnElement;
  connection?: BpmnConnection;
  newSelection?: BpmnElement[];
  oldSelection?: BpmnElement[];
  context?: {
    element?: BpmnElement;
    connection?: BpmnConnection;
    source?: BpmnElement;
    target?: BpmnElement;
    shape?: BpmnElement;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BpmnElementRegistry {
  get(id: string): BpmnElement | undefined;
  filter(predicate: (element: BpmnElement) => boolean): BpmnElement[];
  getAll(): BpmnElement[];
  forEach(callback: (element: BpmnElement) => void): void;
  getGraphics(element: BpmnElement): SVGElement | undefined;
}

export interface BpmnModeling {
  updateProperties(element: BpmnElement, properties: Record<string, unknown>): void;
  removeElements(elements: BpmnElement[]): void;
  createShape(shape: Partial<BpmnElement>, position: { x: number; y: number }, parent?: BpmnElement): BpmnElement;
}

export interface BpmnModdle {
  create(type: string, properties?: Record<string, unknown>): BpmnModdleElement;
  toXML(element: BpmnModdleElement, options?: Record<string, unknown>): Promise<{ xml: string; warnings: unknown[] }>;
  fromXML(xml: string, options?: Record<string, unknown>): Promise<{ rootElement: BpmnModdleElement; warnings: unknown[] }>;
}

export interface BpmnRenderer {
  canRender(element: BpmnElement): boolean;
  drawShape(parentNode: SVGElement, element: BpmnElement): SVGElement;
  drawConnection(parentNode: SVGElement, element: BpmnConnection): SVGElement;
  getShapePath(element: BpmnElement): string;
}

export interface BpmnCanvas {
  getRootElement(): BpmnElement;
  setRootElement(element: BpmnElement): void;
  getContainer(): HTMLElement;
  zoom(factor?: number | string): number;
}

export interface BpmnModeler {
  get(service: 'eventBus'): BpmnEventBus;
  get(service: 'elementRegistry'): BpmnElementRegistry;
  get(service: 'modeling'): BpmnModeling;
  get(service: 'moddle'): BpmnModdle;
  get(service: 'canvas'): BpmnCanvas;
  get(service: string): unknown;
  importXML(xml: string): Promise<{ warnings: unknown[] }>;
  saveXML(options?: { format?: boolean }): Promise<{ xml: string; error?: Error }>;
  saveSVG(): Promise<{ svg: string }>;
  destroy(): void;
  on(event: string, callback: (event: BpmnEvent) => void): void;
}

// ── Port-related moddle shapes ────────────────────────────────────────────────

export interface DexpiPortModdle extends BpmnModdleElement {
  $type: 'dexpi:Port';
  portId?: string;
  id?: string;
  name?: string;
  label?: string;
  portType?: string;
  type?: string;
  direction?: string;
  anchorSide?: string;
  anchorOffset?: number;
  anchorX?: number;
  anchorY?: number;
  subReference?: string;
  superReference?: string;
}

export interface DexpiElementModdle extends BpmnModdleElement {
  $type: 'dexpi:Element';
  dexpiType?: string;
  identifier?: string;
  uid?: string;
  hierarchyLevel?: string;
  customUri?: string;
  ports?: DexpiPortModdle[];
  $children?: DexpiPortModdle[];
}
