/**
 * The transcript date-range picker, with a live count of what the range would actually cover.
 *
 * Shared by the create dialog and the re-review dialog so the two cannot drift. The count is a real
 * query, not a placeholder: it is the only thing that tells a user their chosen window is empty *before*
 * they wait for an analysis to come back with nothing.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Caption1, InfoLabel, Text, makeStyles, tokens } from '@fluentui/react-components';
import { DatePicker } from '@fluentui/react-datepicker-compat';
import { runtimeService } from '../services/runtime-service';
import { useRuntimePreflight } from '../hooks/use-runtime';
import type { RuntimeBlockReason } from '../models/runtime';
import { calendarDay, isSchedulableRange } from '../services/snapshot-orchestration';

const useStyles = makeStyles({
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  input: { flexGrow: 1, minWidth: '140px' },
  muted: { color: tokens.colorNeutralForeground2 },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1 },
});

/** Short locale date, so the pickers don't render JS's default `Fri Aug 14 2026`. */
function formatPickerDate(date?: Date): string {
  return date ? date.toLocaleDateString() : '';
}

/**
 * Blocks no choice of dates can clear. Picking a different window cannot move an agent into this
 * environment, switch transcript recording on, or conjure an agent, so for these the pickers are
 * pointless and go disabled. Every other block leaves the dates worth editing.
 */
const DEAD_END_BLOCKS: readonly RuntimeBlockReason[] = ['other-environment', 'recording-off', 'no-agent'];

export interface TranscriptRangeFieldProps {
  agentId?: string;
  /** Where the agent lives; decides whether runtime analysis is possible at all. */
  environmentUrl?: string;
  startDate: Date | null;
  endDate: Date | null;
  onStartDateChange: (date: Date | null) => void;
  onEndDateChange: (date: Date | null) => void;
  disabled?: boolean;
}

export function TranscriptRangeField({
  agentId,
  environmentUrl,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  disabled,
}: TranscriptRangeFieldProps) {
  const styles = useStyles();

  const startIso = calendarDay(startDate);
  const endIso = calendarDay(endDate);

  /**
   * Why a run is impossible, when it is. The pickers stay visible and go disabled rather than
   * disappearing: a field that vanishes answers nothing, and the causes need different actions from
   * the user - only some of which are theirs to take.
   */
  const preflight = useRuntimePreflight(agentId, environmentUrl, startIso, endIso);
  const blocked = preflight.data && !preflight.data.canRun ? preflight.data : undefined;

  /**
   * An empty range is the one block the user can clear from this field, so the pickers stay live for
   * it. Disabling them would leave the only remedy - widening the dates - out of reach. A failed
   * *read* is treated the same way: it is usually a transient refusal from the connector rather than
   * a real privilege verdict, and on "Review again" the range is required input, so locking the
   * pickers over a blip strands the user with a form they cannot complete.
   */
  const pickersDisabled = disabled || Boolean(blocked?.reason && DEAD_END_BLOCKS.includes(blocked.reason));

  /**
   * The engine accepts only a canonical, strictly increasing UTC day range
   * (`models/orchestration.ts`), so there is nothing to count until one exists.
   */
  const rangeReady = isSchedulableRange(startDate, endDate);

  const count = useQuery({
    queryKey: ['transcript-count', agentId ?? '', startIso ?? '', endIso ?? ''],
    queryFn: () => runtimeService.countTranscripts(agentId ?? '', startIso, endIso),
    enabled: Boolean(agentId) && rangeReady && !blocked,
    staleTime: 60 * 1000,
    // Same transient connector refusal the preflight guards against; one retry, then report.
    retry: 1,
  });

  const summary = useMemo(() => {
    if (!agentId) return null;
    // The reason a run is impossible outranks anything about the range: counting transcripts we
    // cannot read, or that live in another environment, would only produce a second wrong answer.
    if (blocked) return { text: blocked.message ?? 'Runtime analysis is not available for this agent.', empty: true };
    // A disabled query stays `pending`, so this has to come first: otherwise the
    // field claims to be counting for as long as the range is incomplete.
    if (!rangeReady) {
      return {
        text: !startIso || !endIso
          ? 'Choose a start and end date to count transcript records.'
          : 'The end date must be after the start date.',
        empty: false,
      };
    }
    if (count.isPending) return { text: 'Counting transcript records…', empty: false };
    if (count.isError || count.data?.unavailable) {
      return { text: 'Transcript records could not be counted.', empty: false };
    }
    const data = count.data;
    if (!data) return null;
    if (data.count === 0) {
      return {
        text: 'No transcript records in this range. A runtime analysis would find nothing.',
        empty: true,
      };
    }
    return {
      text: `Returning ${data.isLowerBound ? 'over ' : ''}${data.count.toLocaleString()} transcript record${data.count === 1 ? '' : 's'}`,
      empty: false,
    };
  }, [agentId, blocked, count.data, count.isError, count.isPending, rangeReady, startIso, endIso]);

  return (
    <div className={styles.group}>
      <InfoLabel info="Transcripts recorded in this window are analysed. Recording is off by default and retention is a rolling 29 days.">
        Date range for transcripts
      </InfoLabel>
      <div className={styles.row}>
        <DatePicker
          className={styles.input}
          value={startDate}
          onSelectDate={(date: Date | null | undefined) => onStartDateChange(date ?? null)}
          formatDate={formatPickerDate}
          maxDate={endDate ?? undefined}
          placeholder="Start date"
          aria-label="Start date"
          disabled={pickersDisabled}
        />
        <Text>to</Text>
        <DatePicker
          className={styles.input}
          value={endDate}
          onSelectDate={(date: Date | null | undefined) => onEndDateChange(date ?? null)}
          formatDate={formatPickerDate}
          minDate={startDate ?? undefined}
          placeholder="End date"
          aria-label="End date"
          disabled={pickersDisabled}
        />
      </div>
      {summary && (blocked || (startIso && endIso && startIso < endIso)) ? (
        <Caption1 className={summary.empty ? styles.warn : styles.muted}>{summary.text}</Caption1>
      ) : null}
    </div>
  );
}
