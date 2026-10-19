/**
 * What a snapshot is doing, while it does it.
 *
 * A snapshot reviews an agent and every agent it calls, so this shows one row per agent rather than
 * the Agent Review Tool's single fixed list of stages: the agent set is not known until capture has
 * expanded the graph, and it differs from one snapshot to the next.
 *
 * Leaving is offered only when the caller passes `onBackground`. The objection that used to rule it
 * out — that there is nothing to return to until a result exists — no longer holds: the snapshot row
 * is saved before the run starts, so the run has an address from its first moment. What leaving does
 * not do is stop anything. The run belongs to the mutation, not to this dialog.
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircleFilled,
  CircleRegular,
  DismissCircleFilled,
  ErrorCircleFilled,
} from '@fluentui/react-icons';
import type {
  AgentReviewProgress,
  AgentReviewStage,
  SnapshotProgress,
} from '../engine/contracts/review-progress';

/**
 * The engine's stages in the words the user sees.
 *
 * Kept in step with the Agent Review Tool's own labels, so the same operation is not called two
 * different things in two products a user moves between.
 */
const STAGE_LABELS: Record<AgentReviewStage, string> = {
  capturing: 'Reading agent configuration',
  'parsing-configuration': 'Parsing configuration',
  'evaluating-patterns': 'Evaluating patterns',
  'checking-compliance': 'Checking compliance',
  'analyzing-runtime': 'Analysing runtime',
  'saving-results': 'Saving results',
};

const useStyles = makeStyles({
  surface: { maxWidth: '520px' },
  intro: { color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalM },
  list: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  // A fixed-width gutter so the names line up whether the icon is a spinner or a glyph.
  icon: { flexShrink: 0, width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '2px' },
  body: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  name: { fontWeight: tokens.fontWeightSemibold },
  role: { color: tokens.colorNeutralForeground3, marginLeft: tokens.spacingHorizontalXS },
  detail: { color: tokens.colorNeutralForeground3 },
  failed: { color: tokens.colorPaletteRedForeground1 },
  done: { color: tokens.colorPaletteGreenForeground1 },
  pending: { color: tokens.colorNeutralForeground4 },
});

function StatusIcon({ agent }: { agent: AgentReviewProgress }) {
  const styles = useStyles();
  if (agent.outcome === 'running') return <Spinner size="tiny" />;
  if (agent.outcome === 'succeeded') return <CheckmarkCircleFilled className={styles.done} />;
  if (agent.outcome === 'failed') return <ErrorCircleFilled className={styles.failed} />;
  if (agent.outcome === 'cancelled') return <DismissCircleFilled className={styles.pending} />;
  return <CircleRegular className={styles.pending} />;
}

/**
 * The line beneath an agent's name.
 *
 * Prefers whatever the engine reported, because that is the only text that knows which of several
 * operations "checking compliance" currently means. The component count is appended rather than
 * replacing it: "n of m" without the stage says how much, but not of what.
 */
function detailFor(agent: AgentReviewProgress): string {
  if (agent.outcome === 'failed') return agent.error ?? 'This agent could not be reviewed';
  if (agent.outcome === 'pending') return 'Waiting';

  const parts: string[] = [agent.detail?.trim() || STAGE_LABELS[agent.stage]];
  if (agent.componentCount) {
    parts.push(`${agent.completedComponents ?? 0} of ${agent.componentCount} components`);
  }
  if (agent.outcome === 'succeeded' && typeof agent.score === 'number') {
    parts.push(`Score ${Math.round(agent.score)}`);
  }
  return parts.join(' · ');
}

export interface SnapshotProgressDialogProps {
  open: boolean;
  /** The review's own name, shown until capture has named the parent agent. */
  title?: string;
  progress: SnapshotProgress | undefined;
  /**
   * Send the run to the background and close this dialog.
   *
   * Omit to keep the dialog captive, which is right where there is nowhere to send the run to.
   */
  onBackground?: () => void;
}

export function SnapshotProgressDialog({ open, title, progress, onBackground }: SnapshotProgressDialogProps) {
  const styles = useStyles();
  const agents = progress?.agents ?? [];
  const parent = agents.find((agent) => agent.role === 'parent');
  const connected = agents.filter((agent) => agent.role === 'connected').length;
  const done = agents.filter((agent) => agent.outcome === 'succeeded' || agent.outcome === 'failed').length;

  const heading = parent?.agentName ?? title ?? 'this agent';

  const intro = agents.length === 0
    ? 'Reading the agent and the agents it calls.'
    : connected === 0
      ? 'Reviewing 1 agent. This usually takes a couple of minutes.'
      : `Reviewing ${agents.length} agents (${done} done). Connected agents are reviewed the same way as the parent.`;

  return (
    // Still no dismiss on the backdrop or Escape: the run cannot be cancelled from here, so a stray
    // click must not read as one. Leaving is an explicit action, and only when the caller has
    // somewhere to put a run that carries on without this dialog watching it.
    <Dialog open={open} modalType="alert">
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Reviewing {heading}</DialogTitle>
          <DialogContent>
            <Text size={200} className={styles.intro}>{intro}</Text>

            <div className={styles.list}>
              {agents.length === 0 ? (
                <div className={styles.row}>
                  <span className={styles.icon}><Spinner size="tiny" /></span>
                  <span className={styles.body}>
                    <Text className={styles.name}>Reading agent configuration</Text>
                    <Text size={200} className={styles.detail}>
                      Finding the connected agents this snapshot has to cover
                    </Text>
                  </span>
                </div>
              ) : (
                agents.map((agent) => (
                  <div key={agent.agentId} className={styles.row}>
                    <span className={styles.icon}><StatusIcon agent={agent} /></span>
                    <span className={styles.body}>
                      <Text className={styles.name}>
                        {agent.agentName}
                        {agent.role === 'connected' ? (
                          <Text size={200} className={styles.role}>Connected</Text>
                        ) : null}
                      </Text>
                      <Text
                        size={200}
                        className={agent.outcome === 'failed' ? styles.failed : styles.detail}
                      >
                        {detailFor(agent)}
                      </Text>
                    </span>
                  </div>
                ))
              )}
            </div>
          </DialogContent>
          {onBackground ? (
            <DialogActions>
              <Button appearance="secondary" onClick={onBackground}>
                Continue in background
              </Button>
            </DialogActions>
          ) : null}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
