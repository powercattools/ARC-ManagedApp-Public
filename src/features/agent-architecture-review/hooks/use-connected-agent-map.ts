import { useQuery } from '@tanstack/react-query';
import {
  loadConnectedAgentMapSnapshotWith,
  type AgentMapConnectedAgentSnapshot,
  type UseConnectedAgentMap,
} from '../engine/scoring/art-ports';
import { createBotService } from '../engine/capture/bot-service';
import { createConnectorTransport } from '../services/connector-transport';

/**
 * The workbench's own implementation of the agent map's connected-agent loader.
 *
 * The map is shared with the Agent Review Tool, but its Dataverse reads are not: ART's client is
 * bound to ART's data sources, so importing it here would resolve against tables this app never
 * registered. Instead the map declares the read as a prop and this supplies it over the connector
 * transport the rest of the workbench already uses.
 */
export const useConnectedAgentMap: UseConnectedAgentMap = (target, orgUrl) => {
  const query = useQuery<AgentMapConnectedAgentSnapshot, Error>({
    queryKey: ['arw', 'agent-map', 'connected-agent', orgUrl ?? 'current', target?.schemaName ?? 'none'],
    queryFn: () => {
      if (!orgUrl) throw new Error('This snapshot did not record its source environment.');
      const bots = createBotService(createConnectorTransport(orgUrl));
      return loadConnectedAgentMapSnapshotWith(bots, target?.schemaName ?? '', orgUrl);
    },
    enabled: target !== null && Boolean(orgUrl),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  return {
    data: query.data,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: () => query.refetch(),
  };
};
