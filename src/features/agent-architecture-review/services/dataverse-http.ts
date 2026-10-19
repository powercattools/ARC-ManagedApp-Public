/**
 * Web API semantics the generated Dataverse connector does not express.
 *
 * The connector reports failures as `{ success: false, error }` and exchanges base64 text where the
 * Web API exchanges bytes. Both are lossy: a caller that branches on "not reserved yet" (404) versus
 * "someone else got there first" (412) cannot tell them apart from a message string, and a file
 * upload cannot be handed a `Uint8Array`. `connector-transport.ts` restores both, and these are the
 * pieces it restores them with.
 *
 * Owned by the app rather than imported. These began life in the review-orchestration POC, whose
 * Node host spoke to the Web API directly; that workspace is no longer part of this package, and a
 * shipping module must not depend on one that is not built or deployed with it.
 */

/**
 * An HTTP failure with its status intact.
 *
 * The status is the payload. Callers branch on 404 (absent) and 412/409 (lost a race) to tell a
 * normal cold start apart from a genuine fault, so collapsing this into `Error` would turn a
 * first-time capture into a hard failure.
 */
export class DataverseHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(`Dataverse HTTP ${status}${code ? ` (${code})` : ''}: ${message}`);
    this.name = 'DataverseHttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Base64-encode bytes for a connector file upload.
 *
 * Chunked because spreading a large array into `fromCharCode` overflows the call stack, and review
 * corpora routinely run to hundreds of kilobytes.
 *
 * `btoa` rather than `Buffer`: `Buffer` is a Node global that a bundler leaves as a free variable
 * instead of failing the build, so it compiles for the browser and then throws `Buffer is not
 * defined` during a real review — a far worse failure than a build error.
 */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
