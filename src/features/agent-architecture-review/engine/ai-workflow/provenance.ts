import type { AgentCapture } from '../capture/agent-capture';
import { isObject, requireCondition } from './wire-data';

export interface FrozenHostReview {
  contract: 'arc2-host-review-v1';
  capturedAt: string;
  sourceFingerprint: string;
  /** The scoring boundary must validate the stored deterministic policy/assessments before merging. */
  deterministic: unknown;
}

/** Stable bytes for data identity, not a signature or an authorization mechanism. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    requireCondition(typeof item === 'object' && item !== null
      && (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null),
    'The frozen review contains data that cannot be serialized as JSON.');
    requireCondition(!active.has(item), 'The frozen review contains a circular reference.');
    active.add(item);
    let result: string;
    if (Array.isArray(item)) result = `[${item.map(encode).join(',')}]`;
    else result = `{${Object.entries(item).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`).join(',')}}`;
    active.delete(item);
    return result;
  }
  return encode(value);
}

export function parseHostReview(value: unknown): FrozenHostReview {
  requireCondition(isObject(value) && Object.keys(value).length === 4
    && value.contract === 'arc2-host-review-v1'
    && typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt))
    && typeof value.sourceFingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.sourceFingerprint)
    && isObject(value.deterministic), 'The frozen host-review provenance is invalid.');
  canonicalJson(value.deterministic);
  return {
    contract: 'arc2-host-review-v1', capturedAt: value.capturedAt,
    sourceFingerprint: value.sourceFingerprint, deterministic: value.deterministic,
  };
}

export async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJson(value));
}

export async function captureFingerprint(capture: AgentCapture): Promise<string> {
  const sources = {
    harness: capture.harness, botId: capture.botId, botName: capture.botName, schemaName: capture.schemaName,
    organization: capture.organization, configuration: capture.configuration,
    agentDescription: capture.agentDescription, agentSettings: capture.agentSettings,
    components: capture.components,
    resources: capture.harness === 'copilot' ? capture.bundles.map(bundle => ({
      skillId: bundle.skillComponentId, markdown: bundle.skillMarkdown,
      manifest: bundle.manifest, retrievalIssues: bundle.retrievalIssues,
      resources: bundle.resources.map(resource => ({
        id: resource.id, path: resource.normalizedPath, size: resource.sizeBytes,
        sha256: resource.sha256, isBinary: resource.isBinary, decodeStatus: resource.decodeStatus,
        text: resource.textContent, issues: resource.issues,
      })),
    })) : [],
  };
  return sha256Bytes(canonicalBytes(sources));
}

export async function freezeHostReview(
  capture: AgentCapture, deterministic: unknown, capturedAt = new Date().toISOString(),
): Promise<FrozenHostReview> {
  // Snapshot both inputs before yielding so an in-flight UI edit cannot bind mismatched sources.
  const frozenCapture = structuredClone(capture);
  const frozenDeterministic = structuredClone(deterministic);
  return parseHostReview({
    contract: 'arc2-host-review-v1', capturedAt,
    sourceFingerprint: await captureFingerprint(frozenCapture), deterministic: frozenDeterministic,
  });
}
