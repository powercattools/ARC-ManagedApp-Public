import type { CopilotAgentCapture } from '../capture/agent-capture';
import { redactSecrets } from '../scoring/art-ports';

/** Keep declared names and identities distinct; neither a display name nor a schema implies a runtime alias. */
export function capturedCapabilityInventory(capture: CopilotAgentCapture) {
  const identity = (item: { componentId?: string; componentIdUnique?: string; schemaname: string; name: string }) => ({
    componentId: item.componentId ?? null,
    componentIdUnique: item.componentIdUnique ?? null,
    schemaName: redactSecrets(item.schemaname),
    name: redactSecrets(item.name),
  });
  const text = (value?: string) => value === undefined ? null : redactSecrets(value);
  const capabilities = [
    ...capture.model.tools.map(item => ({
      ...identity(item), type: 'tool', kind: item.kind, displayName: text(item.displayName),
      description: text(item.description), connectorId: text(item.connectorId), operationId: text(item.operationId),
    })),
    ...capture.model.skills.map(item => ({
      ...identity(item), type: 'skill', frontmatterName: text(item.frontmatterName),
      description: text(item.frontmatterDescription),
    })),
    ...capture.model.connectedAgents.map(item => ({
      ...identity(item), type: 'connected-agent', displayName: text(item.displayName), description: text(item.description),
      targetSchemaName: text(item.botSchemaName), targetEnvironment: 'not-captured', childContent: 'not-captured',
    })),
    ...capture.model.knowledge.map(item => ({
      ...identity(item), type: 'knowledge', sourceKind: text(item.sourceKind),
    })),
  ];
  const represented = new Set([
    ...capabilities.map(item => item.componentId),
    ...capture.model.evaluationSets.map(item => item.componentId),
    ...capture.model.testCases.map(item => item.componentId),
    ...capture.model.triggers.map(item => item.componentId),
  ]);
  const unreviewedExecutableComponents = capture.components
    .filter(component => String(component.componenttype) === '9' && !represented.has(component.botcomponentid))
    .map(component => ({
      componentId: component.botcomponentid, schemaName: redactSecrets(component.schemaname),
      name: redactSecrets(component.name),
      reason: 'The captured executable component was not represented by the Copilot parser.',
    }));
  return {
    contract: 'arc2-capability-inventory-v1',
    agentId: capture.botId, sourceEnvironment: capture.organization, executionContext: 'direct-parent-agent',
    capabilities,
    unreviewedExecutableComponents,
    limits: [
      'Names are captured fields, not proven interchangeable invocation aliases.',
      'Connected-agent internals and transitive capabilities are not part of this parent inventory.',
      'An MCP entry does not enumerate the remote service tool catalog.',
    ],
  };
}
