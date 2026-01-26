import type { DexpiElement, DexpiPort, DexpiStream } from '../dexpi/moddle';

interface TransformOptions {
  projectName?: string;
  projectDescription?: string;
  author?: string;
}

export class BpmnToDexpiTransformer {
  private processSteps: Map<string, any> = new Map();
  private streams: Map<string, any> = new Map();
  private ports: Map<string, any> = new Map();
  private materialTemplates: Map<string, any> = new Map();
  private materialComponents: Map<string, any> = new Map();
  private materialStates: Map<string, any> = new Map();

  async transform(bpmnXml: string, options: TransformOptions = {}): Promise<string> {
    console.log('=== Starting BPMN to DEXPI Transformation ===');
    
    // Clear state from previous transformations
    this.processSteps.clear();
    this.streams.clear();
    this.ports.clear();
    this.materialTemplates.clear();
    this.materialComponents.clear();
    this.materialStates.clear();
    
    // Parse BPMN XML
    const bpmnModel = this.parseBpmn(bpmnXml);
    console.log('✓ Parsed BPMN XML');
    
    // Extract DEXPI elements
    this.extractElements(bpmnModel);
    console.log(`✓ Extracted: ${this.processSteps.size} process steps, ${this.streams.size} streams, ${this.ports.size} ports`);
    
    // Build DEXPI XML structure
    const dexpiModel = this.buildDexpiModel(options);
    console.log('✓ Built DEXPI model structure');
    
    // Generate XML
    const xml = this.generateXml(dexpiModel);
    console.log('✓ Generated DEXPI XML');
    console.log('=== Transformation Complete ===');
    
    return xml;
  }

  private parseBpmn(xml: string): Document {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    
    // Check for parse errors
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      throw new Error('Failed to parse BPMN XML: ' + parserError.textContent);
    }
    
    return doc;
  }

  private extractElements(doc: Document): void {
    const process = doc.querySelector('process');
    if (!process) return;

    // Extract tasks (ProcessSteps) - including all task types
    const tasks = Array.from(process.querySelectorAll('task, subProcess, serviceTask, userTask, scriptTask, manualTask, businessRuleTask, sendTask, receiveTask, callActivity'));
    tasks.forEach((task) => {
      this.extractProcessStep(task);
    });

    // Extract start events (Sources)
    const startEvents = Array.from(process.querySelectorAll('startEvent, intermediateCatchEvent'));
    startEvents.forEach((event) => {
      this.extractSource(event);
    });

    // Extract end events (Sinks)
    const endEvents = Array.from(process.querySelectorAll('endEvent, intermediateThrowEvent'));
    endEvents.forEach((event) => {
      this.extractSink(event);
    });

    // Extract sequence flows (Streams)
    const sequenceFlows = Array.from(process.querySelectorAll('sequenceFlow'));
    sequenceFlows.forEach((flow) => {
      this.extractStream(flow);
    });

    // Extract data objects (MaterialTemplates, MaterialComponents, MaterialStates)
    const dataObjects = Array.from(process.querySelectorAll('dataObjectReference'));
    dataObjects.forEach((obj) => {
      this.extractMaterialData(obj);
    });
  }

  private extractProcessStep(task: Element): void {
    const id = task.getAttribute('id') || '';
    const name = task.getAttribute('name') || id;
    
    // Extract DEXPI extension elements
    const dexpiData = this.extractDexpiExtension(task);
    
    const processStep = {
      id,
      name,
      type: dexpiData?.dexpiType || 'ProcessStep',
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      ports: dexpiData?.ports || []
    };

    console.log(`Extracted process step ${id} with ${processStep.ports.length} ports:`, processStep.ports);

    this.processSteps.set(id, processStep);
    
    // Register ports
    processStep.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, {
        ...port,
        parentId: id
      });
    });
  }

  private extractSource(event: Element): void {
    const id = event.getAttribute('id') || '';
    const name = event.getAttribute('name') || id;
    
    const dexpiData = this.extractDexpiExtension(event);
    
    const source = {
      id,
      name,
      type: 'Source',
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      ports: dexpiData?.ports || []
    };

    this.processSteps.set(id, source);
    
    source.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, {
        ...port,
        parentId: id
      });
    });
  }

  private extractSink(event: Element): void {
    const id = event.getAttribute('id') || '';
    const name = event.getAttribute('name') || id;
    
    const dexpiData = this.extractDexpiExtension(event);
    
    const sink = {
      id,
      name,
      type: 'Sink',
      identifier: dexpiData?.identifier || id,
      uid: dexpiData?.uid || this.generateUid(),
      ports: dexpiData?.ports || []
    };

    this.processSteps.set(id, sink);
    
    sink.ports.forEach((port: DexpiPort) => {
      this.ports.set(port.portId, {
        ...port,
        parentId: id
      });
    });
  }

  private extractStream(flow: Element): void {
    const id = flow.getAttribute('id') || '';
    const name = flow.getAttribute('name') || id;
    const sourceRef = flow.getAttribute('sourceRef') || '';
    const targetRef = flow.getAttribute('targetRef') || '';
    
    const dexpiData = this.extractDexpiStreamExtension(flow);
    
    const stream = {
      id,
      name,
      identifier: dexpiData?.identifier || id,
      uid: this.generateUid(),
      sourceRef,
      targetRef,
      sourcePortRef: dexpiData?.sourcePortRef,
      targetPortRef: dexpiData?.targetPortRef,
      streamType: dexpiData?.streamType || 'MaterialFlow',
      templateReference: dexpiData?.templateReference,
      materialStateReference: dexpiData?.materialStateReference,
      provenance: dexpiData?.provenance || 'Calculated',
      range: dexpiData?.range || 'Design',
      attributes: dexpiData?.attributes || []
    };

    this.streams.set(id, stream);
  }

  private extractMaterialData(dataObj: Element): void {
    const id = dataObj.getAttribute('id') || '';
    const name = dataObj.getAttribute('name') || id;
    
    const extensionElements = dataObj.querySelector('extensionElements');
    if (!extensionElements) return;

    // Extract MaterialTemplates
    const templates = Array.from(extensionElements.querySelectorAll('MaterialTemplate'));
    templates.forEach(template => {
      const uid = template.getAttribute('uid') || this.generateUid();
      const identifier = this.getChildText(template, 'Identifier');
      const label = this.getChildText(template, 'Label');
      const description = this.getChildText(template, 'Description');
      const numberOfComponents = this.getChildText(template, 'NumberOfMaterialComponents');
      const numberOfPhases = this.getChildText(template, 'NumberOfPhases');

      this.materialTemplates.set(uid, {
        uid,
        identifier,
        label,
        description,
        numberOfComponents,
        numberOfPhases
      });
    });

    // Extract MaterialComponents
    const components = Array.from(extensionElements.querySelectorAll('MaterialComponent'));
    components.forEach(component => {
      const uid = component.getAttribute('uid') || this.generateUid();
      const identifier = this.getChildText(component, 'Identifier');
      const label = this.getChildText(component, 'Label');
      const description = this.getChildText(component, 'Description');
      const chebiId = this.getChildText(component, 'ChEBI_identifier');
      const iupacId = this.getChildText(component, 'IUPAC_identifier');

      this.materialComponents.set(uid, {
        uid,
        identifier,
        label,
        description,
        chebiId,
        iupacId
      });
    });

    // Extract MaterialStates from Case elements
    const cases = Array.from(extensionElements.querySelectorAll('Case'));
    cases.forEach(caseElement => {
      // Extract case name
      let caseName: string | null = null;
      for (let i = 0; i < caseElement.children.length; i++) {
        const child = caseElement.children[i];
        const localName = child.localName || child.tagName.split(':').pop() || '';
        if (localName.toLowerCase() === 'casename') {
          caseName = child.textContent || '';
          break;
        }
      }

      // Extract MaterialStates within this Case
      const states = Array.from(caseElement.querySelectorAll('MaterialState'));
      states.forEach(state => {
        const uid = state.getAttribute('uid') || this.generateUid();
        const identifier = this.getChildText(state, 'Identifier');
        const label = this.getChildText(state, 'Label');
        const description = this.getChildText(state, 'Description');
        const templateRef = this.getChildValue(state, 'TemplateReference', 'uidRef');
        
        // Store the case name with the state
        const stateWithCase = caseName || name;

        // Extract Flow data
        const flowElement = Array.from(state.children).find((c: any) => c.tagName === 'Flow' || c.localName === 'Flow');
        let flow: any = null;
        
        if (flowElement) {
          const moleFlowElement = Array.from(flowElement.children).find((c: any) => c.tagName === 'MoleFlow' || c.localName === 'MoleFlow');
          const compositionElement = Array.from(flowElement.children).find((c: any) => c.tagName === 'Composition' || c.localName === 'Composition');
          
          flow = {};
          
          if (moleFlowElement) {
            flow.moleFlow = {
              value: this.getChildText(moleFlowElement as Element, 'Value'),
              unit: this.getChildText(moleFlowElement as Element, 'Unit')
            };
          }
          
          if (compositionElement) {
            const fractions = Array.from((compositionElement as Element).querySelectorAll('Fraction'));
            flow.composition = {
              basis: this.getChildText(compositionElement as Element, 'Basis'),
              display: this.getChildText(compositionElement as Element, 'Display'),
              fractions: fractions.map(f => this.getChildText(f, 'Value'))
            };
          }
        }

        this.materialStates.set(uid, {
          uid,
          identifier,
          label,
          description,
          caseName: stateWithCase,
          templateRef,
          flow
        });
      });
    });
  }

  private getChildText(parent: Element, childName: string): string {
    const child = Array.from(parent.children).find((c: any) => 
      c.tagName === childName || c.localName === childName
    );
    return child?.textContent || '';
  }

  private getChildValue(parent: Element, childName: string, attrName: string): string {
    const child = Array.from(parent.children).find((c: any) => 
      c.tagName === childName || c.localName === childName
    );
    return child?.getAttribute(attrName) || '';
  }

  private extractDexpiExtension(element: Element): DexpiElement | null {
    const extensionElements = element.querySelector('extensionElements');
    if (!extensionElements) {
      console.log('No extensionElements found');
      return null;
    }

    console.log('Extension elements children:', extensionElements.children.length);
    
    // Try multiple ways to find the dexpi:element
    let dexpiElement: Element | null = null;
    
    // Method 1: Direct children search (works with namespaces)
    for (let i = 0; i < extensionElements.children.length; i++) {
      const child = extensionElements.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      console.log(`Child ${i}: tagName=${child.tagName}, localName=${localName}`);
      if (localName.toLowerCase() === 'element') {
        dexpiElement = child;
        console.log('Found dexpi:element!', dexpiElement);
        break;
      }
    }
    
    if (dexpiElement) {
      console.log('Extracting ports from dexpi:element, children count:', dexpiElement.children.length);
      const ports = this.extractPortsFromElement(dexpiElement);
      console.log('Extracted ports:', ports);
      return {
        dexpiType: dexpiElement.getAttribute('dexpiType') || undefined,
        identifier: dexpiElement.getAttribute('identifier') || undefined,
        uid: dexpiElement.getAttribute('uid') || undefined,
        ports
      };
    }

    console.log('No dexpi:element found, trying legacy format');
    // Fallback: try to find ports directly in extensionElements (legacy format)
    const ports = this.extractPortsFromExtensionElements(extensionElements);
    console.log('Legacy format ports:', ports);
    if (ports.length > 0) {
      return {
        ports
      };
    }

    console.log('No ports found at all');
    return null;
  }

  private extractDexpiStreamExtension(element: Element): DexpiStream | null {
    const extensionElements = element.querySelector('extensionElements');
    if (!extensionElements) return null;

    // Try to find stream with or without namespace
    let dexpiStream: Element | null = null;
    for (let i = 0; i < extensionElements.children.length; i++) {
      const child = extensionElements.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'stream') {
        dexpiStream = child;
        break;
      }
    }
    
    if (!dexpiStream) return null;

    // Extract stream attributes
    const attributes: any[] = [];
    for (let i = 0; i < dexpiStream.children.length; i++) {
      const child = dexpiStream.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      if (localName.toLowerCase() === 'streamattribute') {
        attributes.push({
          name: child.getAttribute('name') || '',
          value: child.getAttribute('value') || '',
          unit: child.getAttribute('unit') || '',
          mode: child.getAttribute('mode') || 'Design',
          qualifier: child.getAttribute('qualifier') || 'Average'
        });
      }
    }

    return {
      identifier: dexpiStream.getAttribute('identifier') || undefined,
      name: dexpiStream.getAttribute('name') || undefined,
      streamType: dexpiStream.getAttribute('streamType') as any,
      sourcePortRef: dexpiStream.getAttribute('sourcePortRef') || undefined,
      targetPortRef: dexpiStream.getAttribute('targetPortRef') || undefined,
      templateReference: dexpiStream.getAttribute('templateReference') || undefined,
      materialStateReference: dexpiStream.getAttribute('materialStateReference') || undefined,
      provenance: dexpiStream.getAttribute('provenance') as any,
      range: dexpiStream.getAttribute('range') as any,
      attributes
    };
  }

  private extractPortsFromElement(dexpiElement: Element): DexpiPort[] {
    const ports: DexpiPort[] = [];
    
    // Iterate through children to find port elements
    for (let i = 0; i < dexpiElement.children.length; i++) {
      const child = dexpiElement.children[i];
      const localName = child.localName || child.tagName.split(':').pop() || '';
      
      if (localName.toLowerCase() === 'port') {
        ports.push({
          portId: child.getAttribute('portId') || child.getAttribute('id') || this.generateUid(),
          name: child.getAttribute('name') || child.getAttribute('label') || 'Port',
          portType: (child.getAttribute('portType') || child.getAttribute('type') || 'MaterialPort') as any,
          direction: (child.getAttribute('direction') || 'Inlet') as any,
          anchorSide: child.getAttribute('anchorSide') as any,
          anchorOffset: child.getAttribute('anchorOffset') ? parseFloat(child.getAttribute('anchorOffset')!) : undefined,
          anchorX: child.getAttribute('anchorX') ? parseFloat(child.getAttribute('anchorX')!) : undefined,
          anchorY: child.getAttribute('anchorY') ? parseFloat(child.getAttribute('anchorY')!) : undefined
        });
      }
    }
    
    return ports;
  }

  private extractPorts(dexpiElement: Element): DexpiPort[] {
    // Try with and without namespace prefix
    let ports = Array.from(dexpiElement.querySelectorAll('port'));
    if (ports.length === 0) {
      ports = Array.from(dexpiElement.querySelectorAll('Port'));
    }
    if (ports.length === 0) return [];
    
    return ports.map((port) => ({
      portId: port.getAttribute('portId') || port.getAttribute('id') || this.generateUid(),
      name: port.getAttribute('name') || port.getAttribute('label') || 'Port',
      portType: (port.getAttribute('portType') || port.getAttribute('type') || 'MaterialPort') as any,
      direction: (port.getAttribute('direction') || 'Inlet') as any,
      anchorSide: port.getAttribute('anchorSide') as any,
      anchorOffset: port.getAttribute('anchorOffset') ? parseFloat(port.getAttribute('anchorOffset')!) : undefined,
      anchorX: port.getAttribute('anchorX') ? parseFloat(port.getAttribute('anchorX')!) : undefined,
      anchorY: port.getAttribute('anchorY') ? parseFloat(port.getAttribute('anchorY')!) : undefined
    }));
  }

  private extractPortsFromExtensionElements(extensionElements: Element): DexpiPort[] {
    const portsContainer = extensionElements.querySelector('ports');
    if (!portsContainer) return [];
    
    const ports = Array.from(portsContainer.querySelectorAll('port'));
    if (ports.length === 0) return [];
    
    return ports.map((port) => ({
      portId: port.getAttribute('id') || port.getAttribute('portId') || this.generateUid(),
      name: port.getAttribute('name') || port.getAttribute('label') || 'Port',
      portType: (port.getAttribute('type') || port.getAttribute('portType') || 'MaterialPort') as any,
      direction: (port.getAttribute('direction') || 'Inlet') as any,
      anchorSide: port.getAttribute('anchorSide') as any,
      anchorOffset: port.getAttribute('anchorOffset') ? parseFloat(port.getAttribute('anchorOffset')!) : undefined,
      anchorX: port.getAttribute('anchorX') ? parseFloat(port.getAttribute('anchorX')!) : undefined,
      anchorY: port.getAttribute('anchorY') ? parseFloat(port.getAttribute('anchorY')!) : undefined
    }));
  }

  private buildDexpiModel(options: TransformOptions): any {
    const modelUid = this.generateUid();
    
    // Build ProcessModel object
    const processModelObject: any = {
      '$': {
        'id': modelUid,
        'type': 'Process/ProcessModel'
      }
    };

    // Add ProcessSteps collection if there are any
    if (this.processSteps.size > 0) {
      processModelObject.Components = {
        '$': {
          'property': 'ProcessSteps'
        },
        'Object': this.buildProcessSteps()
      };
    }

    // Add ProcessConnections (Streams) collection if there are any
    if (this.streams.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const streamsComponent = {
        '$': {
          'property': 'ProcessConnections'
        },
        'Object': this.buildStreams()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(streamsComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, streamsComponent];
      }
    }

    // Add MaterialTemplates collection if there are any
    if (this.materialTemplates.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const templatesComponent = {
        '$': {
          'property': 'MaterialTemplates'
        },
        'Object': this.buildMaterialTemplates()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(templatesComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, templatesComponent];
      }
    }

    // Add MaterialComponents collection if there are any
    if (this.materialComponents.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const componentsComponent = {
        '$': {
          'property': 'MaterialComponents'
        },
        'Object': this.buildMaterialComponents()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(componentsComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, componentsComponent];
      }
    }

    // Add MaterialStates collection if there are any
    if (this.materialStates.size > 0) {
      if (!processModelObject.Components) {
        processModelObject.Components = [];
      }
      const statesComponent = {
        '$': {
          'property': 'MaterialStates'
        },
        'Object': this.buildMaterialStates()
      };
      
      if (Array.isArray(processModelObject.Components)) {
        processModelObject.Components.push(statesComponent);
      } else {
        processModelObject.Components = [processModelObject.Components, statesComponent];
      }
    }

    // Build the full Model structure following DEXPI 2.0.0 specification
    const model: any = {
      'Model': {
        '$': {
          'name': 'process-model',
          'uri': 'http://www.example.org'
        },
        'Import': [
          {
            '$': {
              'prefix': 'Core',
              'source': 'https://data.dexpi.org/models/2.0.0/Core.xml'
            }
          },
          {
            '$': {
              'prefix': 'Process',
              'source': 'https://data.dexpi.org/models/2.0.0/Process.xml'
            }
          }
        ],
        'Object': {
          '$': {
            'type': 'Core/EngineeringModel'
          },
          'Components': {
            '$': {
              'property': 'ConceptualModel'
            },
            'Object': processModelObject
          }
        }
      }
    };

    return model;
  }

  private buildProcessSteps(): any[] {
    const steps: any[] = [];

    this.processSteps.forEach((step) => {
      const dexpiStep: any = {
        '$': {
          'id': step.uid,
          'type': `Process/${step.type}`
        },
        'Data': {
          '$': {
            'property': 'Identifier'
          },
          'String': step.identifier
        }
      };

      // Add Label if present
      if (step.name) {
        if (Array.isArray(dexpiStep.Data)) {
          dexpiStep.Data.push({
            '$': {
              'property': 'Label'
            },
            'String': step.name
          });
        } else {
          dexpiStep.Data = [
            dexpiStep.Data,
            {
              '$': {
                'property': 'Label'
              },
              'String': step.name
            }
          ];
        }
      }

      // Add ports as composition properties
      if (step.ports && step.ports.length > 0) {
        console.log(`Building ports for step ${step.id}:`, step.ports);
        const portObjects: any[] = [];
        
        step.ports.forEach((port: DexpiPort) => {
          const portObject: any = {
            '$': {
              'id': port.portId,
              'type': `Process/Process.${port.portType}`
            },
            'Data': [
              {
                '$': {
                  'property': 'Identifier'
                },
                'String': port.portId
              },
              {
                '$': {
                  'property': 'NominalDirection'
                },
                'DataReference': {
                  '$': {
                    'data': `Process/Enumerations.PortDirectionClassification.${port.direction === 'Inlet' ? 'In' : 'Out'}`
                  }
                }
              }
            ]
          };

          // Add Label if present
          if (port.name) {
            portObject.Data.push({
              '$': {
                'property': 'Label'
              },
              'String': port.name
            });
          }

          portObjects.push(portObject);
        });

        dexpiStep.Components = {
          '$': {
            'property': 'Ports'
          },
          'Object': portObjects
        };
        
        console.log(`Added ${portObjects.length} ports to DEXPI step`);
      }

      steps.push(dexpiStep);
    });

    return steps;
  }

  private buildStreams(): any[] {
    const streamElements: any[] = [];

    this.streams.forEach((stream) => {
      const sourcePort = this.findPortForConnection(stream.sourceRef, stream.sourcePortRef, 'Outlet');
      const targetPort = this.findPortForConnection(stream.targetRef, stream.targetPortRef, 'Inlet');

      if (!sourcePort || !targetPort) {
        console.warn(`Cannot create stream ${stream.id}: missing port references`);
        return;
      }

      const streamType = stream.streamType === 'MaterialFlow' ? 'Stream' : 'EnergyFlow';
      const dexpiStream: any = {
        '$': {
          'id': stream.uid,
          'type': `Process/Process.${streamType}`
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': stream.identifier
          }
        ],
        'References': [
          {
            '$': {
              'objects': `#${sourcePort}`,
              'property': 'Source'
            }
          },
          {
            '$': {
              'objects': `#${targetPort}`,
              'property': 'Target'
            }
          }
        ]
      };

      // Add MaterialStateReference if present
      if (stream.materialStateReference) {
        dexpiStream.References.push({
          '$': {
            'property': 'MaterialStateReference'
          },
          'ObjectReference': {
            '$': {
              'ref': stream.materialStateReference
            }
          }
        });
      }

      // Add Label if present
      if (stream.name) {
        dexpiStream.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': stream.name
        });
      }

      // Add Provenance if present
      if (stream.provenance) {
        dexpiStream.Data.push({
          '$': {
            'property': 'Provenance'
          },
          'String': stream.provenance
        });
      }

      // Add Range if present
      if (stream.range) {
        dexpiStream.Data.push({
          '$': {
            'property': 'Range'
          },
          'String': stream.range
        });
      }

      // Add all stream attributes as Data properties
      if (stream.attributes && stream.attributes.length > 0) {
        stream.attributes.forEach((attr: any) => {
          if (!attr.name || !attr.value) return;
          
          const attrData: any = {
            '$': {
              'property': attr.name
            }
          };

          // If unit is provided, create a qualified value
          if (attr.unit) {
            attrData.Object = {
              '$': {
                'type': 'Core/QualifiedValue'
              },
              'Data': {
                '$': {
                  'property': 'Value'
                },
                'AggregatedDataValue': {
                  '$': {
                    'type': 'Core/PhysicalQuantities.PhysicalQuantity'
                  },
                  'Data': [
                    {
                      '$': {
                        'property': 'Value'
                      },
                      'Double': attr.value
                    },
                    {
                      '$': {
                        'property': 'Unit'
                      },
                      'String': attr.unit
                    }
                  ]
                }
              }
            };
            
            // Add mode and qualifier if present
            if (attr.mode) {
              attrData.Object.Data.Data.push({
                '$': {
                  'property': 'Mode'
                },
                'String': attr.mode
              });
            }
            if (attr.qualifier) {
              attrData.Object.Data.Data.push({
                '$': {
                  'property': 'Qualifier'
                },
                'String': attr.qualifier
              });
            }
          } else {
            // Simple string value
            attrData.String = attr.value;
          }

          dexpiStream.Data.push(attrData);
        });
      }

      // Legacy: Add mass flow if it's a material stream (kept for backwards compatibility)
      if (stream.streamType === 'MaterialFlow' && stream.attributes) {
        const massFlowAttr = stream.attributes.find((a: any) => a.name === 'MassFlow');
        if (massFlowAttr) {
          dexpiStream.Components = {
            '$': {
              'property': 'MassFlow'
            },
            'Object': {
              '$': {
                'type': 'Core/QualifiedValue'
              },
              'Data': {
                '$': {
                  'property': 'Value'
                },
                'AggregatedDataValue': {
                  '$': {
                    'type': 'Core/PhysicalQuantities.PhysicalQuantity'
                  },
                  'Data': [
                    {
                      '$': {
                        'property': 'Value'
                      },
                      'Double': massFlowAttr.value
                    },
                    {
                      '$': {
                        'property': 'Unit'
                      },
                      'DataReference': {
                        '$': {
                          'data': 'Core/PhysicalQuantities.MassFlowRateUnit.' + (massFlowAttr.unit || 'kgh')
                        }
                      }
                    }
                  ]
                }
              }
            }
          };
        }
      }

      streamElements.push(dexpiStream);
    });

    return streamElements;
  }

  private buildMaterialTemplates(): any[] {
    const templates: any[] = [];

    this.materialTemplates.forEach((template) => {
      const dexpiTemplate: any = {
        '$': {
          'id': template.uid,
          'type': 'Process/Process.MaterialTemplate'
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': template.identifier
          }
        ]
      };

      // Add Label if present
      if (template.label) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': template.label
        });
      }

      // Add Description if present
      if (template.description) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'Description'
          },
          'String': template.description
        });
      }

      // Add NumberOfMaterialComponents if present
      if (template.numberOfComponents) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'NumberOfMaterialComponents'
          },
          'Number': template.numberOfComponents
        });
      }

      // Add NumberOfPhases if present
      if (template.numberOfPhases) {
        dexpiTemplate.Data.push({
          '$': {
            'property': 'NumberOfPhases'
          },
          'Number': template.numberOfPhases
        });
      }

      templates.push(dexpiTemplate);
    });

    return templates;
  }

  private buildMaterialComponents(): any[] {
    const components: any[] = [];

    this.materialComponents.forEach((component) => {
      const dexpiComponent: any = {
        '$': {
          'id': component.uid,
          'type': 'Process/Process.MaterialComponent'
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': component.identifier
          }
        ]
      };

      // Add Label if present
      if (component.label) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': component.label
        });
      }

      // Add Description if present
      if (component.description) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'Description'
          },
          'String': component.description
        });
      }

      // Add ChEBI_identifier if present
      if (component.chebiId) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'ChEBI_identifier'
          },
          'String': component.chebiId
        });
      }

      // Add IUPAC_identifier if present
      if (component.iupacId) {
        dexpiComponent.Data.push({
          '$': {
            'property': 'IUPAC_identifier'
          },
          'String': component.iupacId
        });
      }

      components.push(dexpiComponent);
    });

    return components;
  }

  private buildMaterialStates(): any[] {
    const states: any[] = [];

    this.materialStates.forEach((state) => {
      const dexpiState: any = {
        '$': {
          'id': state.uid,
          'type': 'Process/Process.MaterialState'
        },
        'Data': [
          {
            '$': {
              'property': 'Identifier'
            },
            'String': state.identifier
          }
        ]
      };

      // Add Label if present
      if (state.label) {
        dexpiState.Data.push({
          '$': {
            'property': 'Label'
          },
          'String': state.label
        });
      }

      // Add Description if present
      if (state.description) {
        dexpiState.Data.push({
          '$': {
            'property': 'Description'
          },
          'String': state.description
        });
      }

      // Add CaseName if present
      if (state.caseName) {
        dexpiState.Data.push({
          '$': {
            'property': 'CaseName'
          },
          'String': state.caseName
        });
      }

      // Add TemplateReference if present
      if (state.templateRef) {
        if (!dexpiState.References) {
          dexpiState.References = [];
        }
        dexpiState.References.push({
          '$': {
            'property': 'TemplateReference'
          },
          'ObjectReference': {
            '$': {
              'ref': state.templateRef
            }
          }
        });
      }

      // Add Flow data if present
      if (state.flow) {
        const flowObject: any = {
          '$': {
            'type': 'Process/Process.Flow'
          },
          'Components': []
        };

        // Add MoleFlow if present
        if (state.flow.moleFlow) {
          flowObject.Components.push({
            '$': {
              'property': 'MoleFlow'
            },
            'Object': {
              '$': {
                'type': 'Process/Process.MoleFlow'
              },
              'Data': [
                {
                  '$': {
                    'property': 'Value'
                  },
                  'Number': state.flow.moleFlow.value
                },
                {
                  '$': {
                    'property': 'Unit'
                  },
                  'String': state.flow.moleFlow.unit
                }
              ]
            }
          });
        }

        // Add Composition if present
        if (state.flow.composition) {
          const compositionObject: any = {
            '$': {
              'property': 'Composition'
            },
            'Object': {
              '$': {
                'type': 'Process/Process.Composition'
              },
              'Data': []
            }
          };

          // Add Basis if present
          if (state.flow.composition.basis) {
            compositionObject.Object.Data.push({
              '$': {
                'property': 'Basis'
              },
              'String': state.flow.composition.basis
            });
          }

          // Add Display if present
          if (state.flow.composition.display) {
            compositionObject.Object.Data.push({
              '$': {
                'property': 'Display'
              },
              'String': state.flow.composition.display
            });
          }

          // Add Fractions if present
          if (state.flow.composition.fractions && state.flow.composition.fractions.length > 0) {
            const fractionObjects = state.flow.composition.fractions.map((fraction: string) => ({
              '$': {
                'type': 'Process/Process.Fraction'
              },
              'Data': {
                '$': {
                  'property': 'Value'
                },
                'Number': fraction
              }
            }));

            compositionObject.Object.Components = {
              '$': {
                'property': 'Fractions'
              },
              'Object': fractionObjects
            };
          }

          flowObject.Components.push(compositionObject);
        }

        if (!dexpiState.Components) {
          dexpiState.Components = [];
        }
        
        dexpiState.Components.push({
          '$': {
            'property': 'Flow'
          },
          'Object': flowObject
        });
      }

      states.push(dexpiState);
    });

    return states;
  }

  private findPortForConnection(elementRef: string, portRef: string | undefined, defaultDirection: string): string | null {
    const element = this.processSteps.get(elementRef);
    if (!element) return null;

    // If specific port is referenced, use it
    if (portRef) {
      const port = this.ports.get(portRef);
      return port ? portRef : null;
    }

    // Otherwise, find first port with matching direction
    const matchingPort = element.ports.find((p: DexpiPort) => p.direction === defaultDirection);
    return matchingPort ? matchingPort.portId : null;
  }

  private generateXml(model: any): string {
    try {
      return this.buildXmlString(model);
    } catch (error) {
      console.error('XML generation error:', error);
      throw new Error(`Failed to generate XML: ${(error as Error).message}`);
    }
  }

  private buildXmlString(obj: any, indent: string = ''): string {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += this.objectToXml(obj, indent);
    return xml;
  }

  private objectToXml(obj: any, indent: string = ''): string {
    let xml = '';
    
    for (const key in obj) {
      const value = obj[key];
      
      if (key === '$') {
        // Skip attributes, they're handled separately
        continue;
      }
      
      if (Array.isArray(value)) {
        value.forEach((item) => {
          xml += this.elementToXml(key, item, indent);
        });
      } else {
        xml += this.elementToXml(key, value, indent);
      }
    }
    
    return xml;
  }

  private elementToXml(tagName: string, value: any, indent: string): string {
    const nextIndent = indent + '  ';
    
    if (value === null || value === undefined) {
      return '';
    }
    
    let xml = `${indent}<${tagName}`;
    
    // Add attributes
    if (value.$ && typeof value.$ === 'object') {
      for (const attrName in value.$) {
        const attrValue = value.$[attrName];
        if (attrValue !== null && attrValue !== undefined) {
          xml += ` ${attrName}="${this.escapeXml(String(attrValue))}"`;
        }
      }
    }
    
    // Check if element has content or children
    const hasChildren = Object.keys(value).some(k => k !== '$');
    
    if (!hasChildren && typeof value !== 'object') {
      // Simple text content
      xml += `>${this.escapeXml(String(value))}</${tagName}>\n`;
    } else if (!hasChildren) {
      // Self-closing tag
      xml += '/>\n';
    } else if (typeof value === 'string') {
      xml += `>${this.escapeXml(value)}</${tagName}>\n`;
    } else {
      // Has children
      xml += '>\n';
      xml += this.objectToXml(value, nextIndent);
      xml += `${indent}</${tagName}>\n`;
    }
    
    return xml;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private generateUid(): string {
    return `uid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

export const transformer = new BpmnToDexpiTransformer();
