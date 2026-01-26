import { parseString, Builder } from 'xml2js';

interface BpmnElement {
  $: any;
  extensionElements?: any[];
  sequenceFlow?: any[];
  task?: any[];
  startEvent?: any[];
  endEvent?: any[];
  dataObjectReference?: any[];
}

export async function exportToDexpiXml(bpmnXml: string): Promise<string> {
  return new Promise((resolve, reject) => {
    parseString(bpmnXml, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      try {
        const dexpiXml = transformBpmnToDexpi(result);
        resolve(dexpiXml);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function transformBpmnToDexpi(bpmnData: any): string {
  const dexpiData: any = {
    ProcessModel: {
      $: {
        'xmlns': 'http://www.dexpi.org/2023/schema',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'SchemaVersion': '3.0'
      },
      ProcessSteps: [],
      Sources: [],
      Sinks: [],
      Streams: [],
      MaterialTemplates: [],
      MaterialStates: []
    }
  };

  const bpmnDefinitions = bpmnData['bpmn:definitions'];
  if (!bpmnDefinitions || !bpmnDefinitions['bpmn:process']) {
    throw new Error('Invalid BPMN structure');
  }

  const process = bpmnDefinitions['bpmn:process'][0];

  // Process tasks (Process Steps and Instrumentation Activities)
  if (process['bpmn:task']) {
    process['bpmn:task'].forEach((task: any) => {
      const dexpiElement = extractDexpiElement(task);
      
      if (dexpiElement) {
        const processStep: any = {
          $: {
            ID: dexpiElement.identifier || task.$.id,
            Name: task.$.name || ''
          },
          Ports: []
        };

        if (dexpiElement.ports && dexpiElement.ports.length > 0) {
          dexpiElement.ports.forEach((port: any) => {
            processStep.Ports.push({
              Port: {
                $: {
                  ID: port.$.portId,
                  Name: port.$.name,
                  Type: port.$.portType,
                  Direction: port.$.direction
                }
              }
            });
          });
        }

        if (dexpiElement.dexpiType === 'ProcessStep') {
          dexpiData.ProcessModel.ProcessSteps.push({ ProcessStep: processStep });
        } else if (dexpiElement.dexpiType === 'InstrumentationActivity') {
          if (!dexpiData.ProcessModel.InstrumentationActivities) {
            dexpiData.ProcessModel.InstrumentationActivities = [];
          }
          dexpiData.ProcessModel.InstrumentationActivities.push({ InstrumentationActivity: processStep });
        }
      }
    });
  }

  // Process start events (Sources)
  if (process['bpmn:startEvent']) {
    process['bpmn:startEvent'].forEach((startEvent: any) => {
      const dexpiElement = extractDexpiElement(startEvent);
      
      const source: any = {
        $: {
          ID: dexpiElement?.identifier || startEvent.$.id,
          Name: startEvent.$.name || 'Source'
        },
        Ports: []
      };

      if (dexpiElement?.ports) {
        dexpiElement.ports.forEach((port: any) => {
          source.Ports.push({
            Port: {
              $: {
                ID: port.$.portId,
                Name: port.$.name,
                Type: port.$.portType,
                Direction: port.$.direction
              }
            }
          });
        });
      }

      dexpiData.ProcessModel.Sources.push({ Source: source });
    });
  }

  // Process end events (Sinks)
  if (process['bpmn:endEvent']) {
    process['bpmn:endEvent'].forEach((endEvent: any) => {
      const dexpiElement = extractDexpiElement(endEvent);
      
      const sink: any = {
        $: {
          ID: dexpiElement?.identifier || endEvent.$.id,
          Name: endEvent.$.name || 'Sink'
        },
        Ports: []
      };

      if (dexpiElement?.ports) {
        dexpiElement.ports.forEach((port: any) => {
          sink.Ports.push({
            Port: {
              $: {
                ID: port.$.portId,
                Name: port.$.name,
                Type: port.$.portType,
                Direction: port.$.direction
              }
            }
          });
        });
      }

      dexpiData.ProcessModel.Sinks.push({ Sink: sink });
    });
  }

  // Process sequence flows (Material/Energy Streams)
  if (process['bpmn:sequenceFlow']) {
    process['bpmn:sequenceFlow'].forEach((flow: any) => {
      const dexpiStream = extractDexpiStream(flow);
      
      const stream: any = {
        $: {
          ID: dexpiStream?.identifier || flow.$.id,
          Name: dexpiStream?.name || flow.$.name || 'Stream',
          SourceRef: flow.$.sourceRef,
          TargetRef: flow.$.targetRef
        }
      };

      if (dexpiStream) {
        if (dexpiStream.streamType) {
          stream.$.Type = dexpiStream.streamType;
        }
        if (dexpiStream.sourcePortRef) {
          stream.$.SourcePortRef = dexpiStream.sourcePortRef;
        }
        if (dexpiStream.targetPortRef) {
          stream.$.TargetPortRef = dexpiStream.targetPortRef;
        }
        if (dexpiStream.templateReference) {
          stream.$.TemplateReference = dexpiStream.templateReference;
        }
        if (dexpiStream.materialStateReference) {
          stream.$.MaterialStateReference = dexpiStream.materialStateReference;
        }
        if (dexpiStream.provenance) {
          stream.$.Provenance = dexpiStream.provenance;
        }
        if (dexpiStream.range) {
          stream.$.Range = dexpiStream.range;
        }

        if (dexpiStream.attributes && dexpiStream.attributes.length > 0) {
          stream.Attributes = [];
          dexpiStream.attributes.forEach((attr: any) => {
            stream.Attributes.push({
              Attribute: {
                $: {
                  Name: attr.$.name,
                  Value: attr.$.value,
                  Unit: attr.$.unit || '',
                  Mode: attr.$.mode || '',
                  Qualifier: attr.$.qualifier || ''
                }
              }
            });
          });
        }
      }

      dexpiData.ProcessModel.Streams.push({ Stream: stream });
    });
  }

  // Process data objects (Material Templates/States)
  if (process['bpmn:dataObjectReference']) {
    process['bpmn:dataObjectReference'].forEach((dataObj: any) => {
      const extensionElements = dataObj.extensionElements;
      
      if (extensionElements && extensionElements[0]) {
        const values = extensionElements[0];
        
        // Check for MaterialTemplate
        if (values['dexpi:MaterialTemplate']) {
          const mtArray = values['dexpi:MaterialTemplate'];
          mtArray.forEach((mt: any) => {
            const template: any = {
              $: {
                ID: mt.$.identifier || dataObj.$.id,
                Name: mt.$.name || dataObj.$.name || 'Material Template',
                UID: mt.$.uid || mt.$.identifier
              }
            };

            if (mt['dexpi:Component']) {
              template.Components = [];
              mt['dexpi:Component'].forEach((comp: any) => {
                template.Components.push({
                  Component: {
                    $: {
                      Name: comp.$.name,
                      CASNumber: comp.$.casNumber || '',
                      Fraction: comp.$.fraction || ''
                    }
                  }
                });
              });
            }

            dexpiData.ProcessModel.MaterialTemplates.push({ MaterialTemplate: template });
          });
        }

        // Check for MaterialState
        if (values['dexpi:MaterialState']) {
          const msArray = values['dexpi:MaterialState'];
          msArray.forEach((ms: any) => {
            const state: any = {
              $: {
                ID: ms.$.identifier || dataObj.$.id,
                Name: ms.$.name || dataObj.$.name || 'Material State',
                UID: ms.$.uid || ms.$.identifier,
                TemplateRef: ms.$.templateRef || ''
              }
            };

            if (ms.$.provenance) {
              state.$.Provenance = ms.$.provenance;
            }
            if (ms.$.range) {
              state.$.Range = ms.$.range;
            }

            if (ms['dexpi:StateProperty']) {
              state.Properties = [];
              ms['dexpi:StateProperty'].forEach((prop: any) => {
                state.Properties.push({
                  Property: {
                    $: {
                      Name: prop.$.name,
                      Value: prop.$.value,
                      Unit: prop.$.unit || ''
                    }
                  }
                });
              });
            }

            dexpiData.ProcessModel.MaterialStates.push({ MaterialState: state });
          });
        }
      }
    });
  }

  // Build XML
  const builder = new Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    renderOpts: { pretty: true, indent: '  ' }
  });
  
  return builder.buildObject(dexpiData);
}

function extractDexpiElement(bpmnElement: any): any {
  if (!bpmnElement.extensionElements || !bpmnElement.extensionElements[0]) {
    return null;
  }

  const extensionValues = bpmnElement.extensionElements[0];
  if (!extensionValues['dexpi:Element']) {
    return null;
  }

  return extensionValues['dexpi:Element'][0];
}

function extractDexpiStream(bpmnFlow: any): any {
  if (!bpmnFlow.extensionElements || !bpmnFlow.extensionElements[0]) {
    return null;
  }

  const extensionValues = bpmnFlow.extensionElements[0];
  if (!extensionValues['dexpi:Stream']) {
    return null;
  }

  return extensionValues['dexpi:Stream'][0];
}
