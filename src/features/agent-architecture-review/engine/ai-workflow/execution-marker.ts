import { requireCondition } from './wire-data';

const HASH = /^[0-9a-f]{64}$/;
const EXECUTION = /^arc2-execution:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ExecutionMarker {
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  inputSha256: string;
  executionId?: string;
  progress: string;
}

export function queuedMarker(inputSha256: string): string {
  requireCondition(HASH.test(inputSha256), 'The handoff requires a SHA-256 digest of the canonical input file.');
  return `ARC2/1|queued|${inputSha256}`;
}

export function executionMarker(
  executionId: string, inputSha256: string, state: Exclude<ExecutionMarker['state'], 'queued'>, progress = '',
): string {
  requireCondition(EXECUTION.test(executionId) && HASH.test(inputSha256) && !progress.includes('|'),
    'The ARC2 execution marker has invalid owner, input digest or progress.');
  const value = `ARC2/1|${executionId}|${inputSha256}|${state}|${progress}`;
  requireCondition(value.length <= 250, 'The execution marker exceeds the Dataverse status-column limit.');
  return value;
}

export function parseExecutionMarker(value: string): ExecutionMarker | null {
  const parts = value.split('|');
  if (parts.length === 3 && parts[0] === 'ARC2/1' && parts[1] === 'queued' && HASH.test(parts[2])) {
    return { state: 'queued', inputSha256: parts[2], progress: '' };
  }
  if (parts.length !== 5 || parts[0] !== 'ARC2/1' || !EXECUTION.test(parts[1])
    || !HASH.test(parts[2]) || value.length > 250) return null;
  const state = parts[3];
  if (state !== 'running' && state !== 'succeeded' && state !== 'failed') return null;
  return { state, inputSha256: parts[2], executionId: parts[1], progress: parts[4] };
}
