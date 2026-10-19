/**
 * React Query bindings for the Setup surface.
 *
 * The checks are deliberately one query rather than seven: they share the
 * organization row, and a per-card refresh that re-read it would multiply the
 * cost of "Re-check" by the number of cards. "Re-check" therefore refetches the
 * whole checklist — cheap enough (four to six calls) and always self-consistent.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENT_ORGANIZATION, setupService } from '../services/setup-service';

const keys = {
  /** Every checklist, whichever environment it was run against. */
  allChecks: ['setup-checks'] as const,
  checks: (organization: string) => ['setup-checks', organization] as const,
  connections: (connectorId: string) => ['available-connections', connectorId] as const,
  createConnectionUrl: (connectorId: string) => ['create-connection-url', connectorId] as const,
  agentReview: ['agent-review-setup'] as const,
};

export function useSetupChecks(organization: string = CURRENT_ORGANIZATION) {
  return useQuery({
    queryKey: keys.checks(organization),
    queryFn: () => setupService.runChecks(organization),
    // Readiness is a point-in-time answer an admin may be actively fixing in
    // another tab, so it is never served stale without a refetch.
    staleTime: 0,
    retry: false,
  });
}

/**
 * Candidate connections for one connector.
 *
 * Only fetched once a picker is actually opened (`enabled`), so expanding the
 * Connections card does not fire a request per row.
 *
 * Connections are read from the environment the app runs in, because that is
 * where the connection references they bind to live — the environment picker
 * does not apply here.
 */
export function useAvailableConnections(connectorId: string | undefined) {
  return useQuery({
    queryKey: keys.connections(connectorId ?? ''),
    queryFn: () => setupService.listAvailableConnections(connectorId!),
    enabled: Boolean(connectorId),
    staleTime: 60 * 1000,
    retry: false,
  });
}

/** Deep link for creating a connection when none of the existing ones fit. */
export function useCreateConnectionUrl(connectorId: string | undefined) {
  return useQuery({
    queryKey: keys.createConnectionUrl(connectorId ?? ''),
    queryFn: () => setupService.createConnectionUrl(connectorId!),
    enabled: Boolean(connectorId),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Flows and connections are part of this app's installation, so changing one
 * changes what every checklist would report. Invalidating by the `setup-checks`
 * prefix refreshes the cached summary for every environment, not just the one
 * on screen.
 */
function useGlobalSetupMutation<TVariables>(mutationFn: (variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.allChecks });
      void queryClient.invalidateQueries({ queryKey: keys.agentReview });
    },
  });
}

export function useSetFlowState() {
  return useGlobalSetupMutation(({ workflowId, on }: { workflowId: string; on: boolean }) =>
    setupService.setFlowState(workflowId, on),
  );
}

export function useMapConnection() {
  return useGlobalSetupMutation(
    ({ referenceId, connectionName }: { referenceId: string; connectionName: string }) =>
      setupService.mapConnection(referenceId, connectionName),
  );
}

/** The guided "Set up agent review" action — validate, bind, activate, verify. */
export function useSetupAgentReview() {
  return useGlobalSetupMutation(() => setupService.setupAgentReview());
}
