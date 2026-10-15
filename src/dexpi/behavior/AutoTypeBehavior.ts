import CommandInterceptor from 'diagram-js/lib/command/CommandInterceptor';
import { DexpiProcessClassRegistry } from '../../transformer/DexpiProcessClassRegistry';
import processXmlRaw from '../../../dexpi-schema-files/Process.xml?raw';

// Build registry once at module load — same approach as DexpiRenderer /
// DexpiPropertiesPanel. Used to recognize InstrumentationActivity
// subclasses, whose connections must not grow InformationPorts (the
// class declares no Ports composition; DEXPI 2.0 connects instrumentation
// via ProcessStepReference / MeasuredVariableReference instead).
const BEHAVIOR_REGISTRY = DexpiProcessClassRegistry.fromXml(processXmlRaw);

/**
 * Automatically sets default DEXPI types for newly created elements
 */
export default class AutoTypeBehavior extends CommandInterceptor {
  private moddle: any;
  private eventBus: any;
  private modeling: any;
  private reconciling = false;

  static $inject = ['eventBus', 'moddle', 'modeling'];

  constructor(eventBus: any, moddle: any, modeling: any) {
    super(eventBus);

    this.moddle = moddle;
    this.eventBus = eventBus;
    this.modeling = modeling;

    // Listen to shape creation
    this.postExecuted('shape.create', (event: any) => {
      const context = event.context;
      const shape = context.shape;
      
      this.autoSetDexpiType(shape);
    });

    // Listen to connection creation for auto-setting stream type
    this.postExecuted('connection.create', (event: any) => {
      const context = event.context;
      const connection = context.connection;
      
      console.log('Connection created:', connection);
      // Small delay to ensure connection is fully established
      setTimeout(() => {
        if (connection.type === 'bpmn:Association' ||
            connection.type === 'bpmn:DataOutputAssociation' ||
            connection.type === 'bpmn:DataInputAssociation') {
          this.autoSetInformationFlow(connection);
        } else {
          this.autoSetStreamType(connection);
        }
      }, 50);
    });

    // Re-classifying a task (e.g. to MeasuringProcessVariable, or away
    // from it) changes whether its data-association chains may carry
    // InformationPorts — reconcile every attached chain. The reconciling
    // flag keeps our own port edits from re-entering.
    this.postExecuted('element.updateProperties', (event: any) => {
      if (this.reconciling) return;
      const el = event.context?.element;
      if (!el || !this.isTaskLike(el)) return;
      const dataObjects = new Set<any>();
      [...(el.incoming || []), ...(el.outgoing || [])].forEach((c: any) => {
        if (
          c.type === 'bpmn:DataInputAssociation' ||
          c.type === 'bpmn:DataOutputAssociation' ||
          c.type === 'bpmn:Association'
        ) {
          const other = c.source === el ? c.target : c.source;
          if (other?.type === 'bpmn:DataObjectReference') dataObjects.add(other);
        }
      });
      dataObjects.forEach((d) => this.reconcileInformationPorts(d));
    });

    // Deleting an association can turn an instrumentation chain into a
    // plain one (or vice versa) — reconcile what remains.
    this.postExecuted('connection.delete', (event: any) => {
      if (this.reconciling) return;
      const connection = event.context?.connection;
      if (
        !connection ||
        (connection.type !== 'bpmn:DataInputAssociation' &&
          connection.type !== 'bpmn:DataOutputAssociation' &&
          connection.type !== 'bpmn:Association')
      ) {
        return;
      }
      const dataObjectEnd = [connection.source, connection.target].find(
        (el: any) => el?.type === 'bpmn:DataObjectReference'
      );
      if (dataObjectEnd) this.reconcileInformationPorts(dataObjectEnd);
    });

  }

  private autoSetDexpiType(element: any): void {
    const businessObject = element.businessObject;
    
    // Check if it's a task-like element
    const isTask = element.type === 'bpmn:Task' || 
                   element.type === 'bpmn:SubProcess' ||
                   element.type?.includes('Task') ||
                   element.type === 'bpmn:CallActivity';
    
    const isStartEvent = element.type === 'bpmn:StartEvent' || 
                         element.type === 'bpmn:IntermediateCatchEvent';
    
    const isEndEvent = element.type === 'bpmn:EndEvent' || 
                       element.type === 'bpmn:IntermediateThrowEvent';

    if (!isTask && !isStartEvent && !isEndEvent) {
      return;
    }

    // Check if it already has extension elements
    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }

    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    // Check if dexpi:Element already exists
    const existingDexpiElement = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
    );

    if (existingDexpiElement) {
      // Already has DEXPI data, don't override
      return;
    }

    // Create new dexpi:Element with default type
    const dexpiElement = this.moddle.create('dexpi:Element');
    
    if (isTask) {
      dexpiElement.dexpiType = 'ProcessStep';
    } else if (isStartEvent) {
      dexpiElement.dexpiType = 'Source';
    } else if (isEndEvent) {
      dexpiElement.dexpiType = 'Sink';
    }

    extensionElements.values.push(dexpiElement);

    // Fire element.changed event to trigger renderer update
    this.eventBus.fire('element.changed', { element });
  }

  private autoSetInformationFlow(connection: any): void {
    const businessObject = connection.businessObject;

    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }
    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    const existingStream = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Stream' || e.$type === 'Stream'
    );
    if (existingStream) return;

    const stream = this.moddle.create('dexpi:Stream');
    stream.streamType = 'InformationFlow';
    stream.uid = businessObject.id;
    stream.identifier = businessObject.id;
    extensionElements.values.push(stream);

    this.modeling.updateProperties(connection, { extensionElements });
    this.eventBus.fire('element.changed', { element: connection });

    // Port management is chain-aware: InformationPorts only make sense
    // when the information flow runs between two non-instrumentation
    // elements (InformationFlow connects InformationPort instances, and
    // only classes with a Ports composition — ProcessSteps — may own
    // one). A chain that touches an InstrumentationActivity connects via
    // ProcessStepReference / MeasuredVariableReference instead, so no
    // ports are created there — and ones auto-created before the task
    // was classified are removed again.
    const dataObjectEnd = [connection.source, connection.target].find(
      (el: any) => el?.type === 'bpmn:DataObjectReference'
    );
    if (dataObjectEnd) {
      this.reconcileInformationPorts(dataObjectEnd);
    }
  }

  private isTaskLike(el: any): boolean {
    return !!el && (
      el.type === 'bpmn:Task' || el.type === 'bpmn:SubProcess' ||
      el.type?.includes('Task') || el.type === 'bpmn:CallActivity'
    );
  }

  private isInstrumentationClassed(el: any): boolean {
    const vals = el?.businessObject?.extensionElements?.values;
    const de = Array.isArray(vals)
      ? vals.find((v: any) => v.$type === 'dexpi:Element' || v.$type === 'dexpi:element')
      : undefined;
    const t = de?.dexpiType || '';
    return !!t && BEHAVIOR_REGISTRY.hasAncestor(t, 'InstrumentationActivity');
  }

  private dataAssociationsOf(dataObject: any): any[] {
    return [...(dataObject.incoming || []), ...(dataObject.outgoing || [])].filter(
      (c: any) =>
        c.type === 'bpmn:DataInputAssociation' ||
        c.type === 'bpmn:DataOutputAssociation' ||
        c.type === 'bpmn:Association'
    );
  }

  private getStreamAnnotation(connection: any): any | undefined {
    const values = connection?.businessObject?.extensionElements?.values;
    return Array.isArray(values)
      ? values.find((e: any) => e.$type === 'dexpi:Stream' || e.$type === 'Stream')
      : undefined;
  }

  private removePortById(element: any, portId: string): void {
    const values = element?.businessObject?.extensionElements?.values;
    const dexpiElement = Array.isArray(values)
      ? values.find((e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element')
      : undefined;
    if (!dexpiElement?.ports) return;
    const before = dexpiElement.ports.length;
    dexpiElement.ports = dexpiElement.ports.filter(
      (pt: any) => (pt.portId || pt.id) !== portId
    );
    if (dexpiElement.ports.length !== before) {
      this.modeling.updateProperties(element, {
        extensionElements: element.businessObject.extensionElements,
      });
      this.eventBus.fire('element.changed', { element });
    }
  }

  private hasPortId(element: any, portId: string): boolean {
    const values = element?.businessObject?.extensionElements?.values;
    const dexpiElement = Array.isArray(values)
      ? values.find((e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element')
      : undefined;
    return !!dexpiElement?.ports?.some((pt: any) => (pt.portId || pt.id) === portId);
  }

  /**
   * Bring the InformationPorts of every data association attached to
   * `dataObject` in line with the chain's nature. Non-instrumentation
   * chain: each task endpoint owns an InformationPort referenced from the
   * association's stream annotation (created here if missing). Chain with
   * an InstrumentationActivity endpoint: no InformationPorts — any that
   * this behavior created earlier (tracked via the annotation's
   * sourcePortId/targetPortId) are removed. Idempotent; re-entrancy
   * guarded because the port edits themselves run updateProperties.
   */
  private reconcileInformationPorts(dataObject: any): void {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const assocs = this.dataAssociationsOf(dataObject);
      const chainInstr = assocs.some((a: any) => {
        const other = a.source === dataObject ? a.target : a.source;
        return this.isTaskLike(other) && this.isInstrumentationClassed(other);
      });

      for (const assoc of assocs) {
        const other = assoc.source === dataObject ? assoc.target : assoc.source;
        if (!this.isTaskLike(other)) continue;
        const outlet = assoc.source === other; // task writes the variable
        const stream = this.getStreamAnnotation(assoc);
        // A freshly drawn association gets its dexpi:Stream annotation in a
        // deferred handler which then reconciles again — creating a port
        // before the annotation exists would leave an untracked orphan
        // when a sibling association triggers reconcile first.
        if (!stream) continue;
        const annotated = outlet ? stream.sourcePortId : stream.targetPortId;

        if (chainInstr) {
          if (annotated) {
            this.removePortById(other, annotated);
            if (outlet) stream.sourcePortId = undefined;
            else stream.targetPortId = undefined;
            this.modeling.updateProperties(assoc, {
              extensionElements: assoc.businessObject.extensionElements,
            });
          }
        } else {
          if (!annotated || !this.hasPortId(other, annotated)) {
            const portName = this.getNextPortName(other, outlet ? 'IO' : 'II');
            this.createPort(other, portName, 'InformationPort', outlet ? 'Outlet' : 'Inlet');
            if (stream) {
              const pid = `${other.businessObject.id}_${portName}_port`;
              if (outlet) stream.sourcePortId = pid;
              else stream.targetPortId = pid;
              this.modeling.updateProperties(assoc, {
                extensionElements: assoc.businessObject.extensionElements,
              });
            }
          }
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private autoSetStreamType(connection: any): void {
    if (connection.type !== 'bpmn:SequenceFlow') {
      return;
    }

    const businessObject = connection.businessObject;

    // Check if it already has extension elements with stream data
    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }

    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    // Check if Stream already exists
    const existingStream = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Stream' || e.$type === 'Stream'
    );

    if (existingStream) {
      // Already has stream data, don't override
      return;
    }

    // Create new Stream with MaterialFlow as default type
    const stream = this.moddle.create('dexpi:Stream');
    stream.streamType = 'MaterialFlow';
    stream.uid = businessObject.id; // Use BPMN ID as UID
    stream.identifier = businessObject.id;

    extensionElements.values.push(stream);

    // Auto-generate ports on source and target elements
    this.autoGeneratePorts(connection, stream.streamType);
  }

  private autoGeneratePorts(connection: any, streamType: string): void {
    const source = connection.source;
    const target = connection.target;

    console.log('Auto-generating ports for connection:', connection.id, 'StreamType:', streamType);
    console.log('Source:', source, 'Target:', target);

    if (!source || !target) {
      console.log('Source or target missing, skipping port generation');
      return;
    }

    // Determine port type based on stream type
    // Determine port type and name prefixes based on stream type
    let portType = 'MaterialPort';
    let outletPrefix = 'MO';
    let inletPrefix = 'MI';

    switch (streamType) {
      case 'ThermalEnergyFlow':
        portType = 'ThermalEnergyPort'; outletPrefix = 'TEO'; inletPrefix = 'TEI'; break;
      case 'MechanicalEnergyFlow':
        portType = 'MechanicalEnergyPort'; outletPrefix = 'MEO'; inletPrefix = 'MEI'; break;
      case 'ElectricalEnergyFlow':
        portType = 'ElectricalEnergyPort'; outletPrefix = 'EEO'; inletPrefix = 'EEI'; break;
      case 'EnergyFlow':
        portType = 'ThermalEnergyPort'; outletPrefix = 'TEO'; inletPrefix = 'TEI'; break; // generic fallback
      case 'InformationFlow':
        portType = 'InformationPort'; outletPrefix = 'IO'; inletPrefix = 'II'; break;
      // MaterialFlow: defaults above
    }

    // Create outlet port on source
    const outletPortName = this.getNextPortName(source, outletPrefix);
    this.createPort(source, outletPortName, portType, 'Outlet');

    // Create inlet port on target
    const inletPortName = this.getNextPortName(target, inletPrefix);
    this.createPort(target, inletPortName, portType, 'Inlet');

    // Update connection name to show port connection
    this.modeling.updateProperties(connection, {
      name: `${outletPortName} - ${inletPortName}`
    });
  }

  private getNextPortName(element: any, prefix: string): string {
    const businessObject = element.businessObject;
    const extensionElements = businessObject.extensionElements;

    let maxNumber = 0;

    if (extensionElements && extensionElements.values) {
      // Check dexpi:Element ports
      const dexpiElement = extensionElements.values.find(
        (e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
      );

      if (dexpiElement && dexpiElement.ports) {
        dexpiElement.ports.forEach((port: any) => {
          const name = port.name || '';
          if (name.startsWith(prefix)) {
            const num = parseInt(name.substring(prefix.length));
            if (!isNaN(num) && num > maxNumber) {
              maxNumber = num;
            }
          }
        });
      }

      // Check legacy ports container
      const portsContainer = extensionElements.values.find(
        (e: any) => {
          const type = (e.$type || '').toLowerCase();
          return type === 'ports' || type.includes('ports') || e.port !== undefined;
        }
      );

      if (portsContainer) {
        const legacyPorts = portsContainer.port || [];
        (Array.isArray(legacyPorts) ? legacyPorts : [legacyPorts]).forEach((port: any) => {
          const name = port.name || port.label || '';
          if (name.startsWith(prefix)) {
            const num = parseInt(name.substring(prefix.length));
            if (!isNaN(num) && num > maxNumber) {
              maxNumber = num;
            }
          }
        });
      }
    }

    return `${prefix}${maxNumber + 1}`;
  }

  private createPort(element: any, portName: string, portType: string, direction: string): void {
    const businessObject = element.businessObject;

    // Ensure extension elements exist
    let extensionElements = businessObject.extensionElements;
    if (!extensionElements) {
      extensionElements = this.moddle.create('bpmn:ExtensionElements');
      businessObject.extensionElements = extensionElements;
    }

    if (!extensionElements.values) {
      extensionElements.values = [];
    }

    // Find or create dexpi:Element
    let dexpiElement = extensionElements.values.find(
      (e: any) => e.$type === 'dexpi:Element' || e.$type === 'dexpi:element'
    );

    if (!dexpiElement) {
      dexpiElement = this.moddle.create('dexpi:Element');
      extensionElements.values.push(dexpiElement);
    }

    // Initialize ports array if it doesn't exist
    if (!dexpiElement.ports) {
      dexpiElement.ports = [];
    }

    // Create the port using dexpi:Port type
    const port = this.moddle.create('dexpi:Port');
    port.portId = `${businessObject.id}_${portName}_port`;
    port.name = portName;
    port.portType = portType;
    port.direction = direction;

    dexpiElement.ports.push(port);

    // Update the element to trigger re-render
    this.modeling.updateProperties(element, {
      extensionElements
    });

    // Fire element.changed event
    this.eventBus.fire('element.changed', { element });
  }
}
