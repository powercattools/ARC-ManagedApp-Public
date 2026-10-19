/**
 * Runs the review pipeline's Dataverse calls through the generated connector.
 *
 * The engine was built against `EngineTransport`, a contract rather than a client. This app has no
 * bearer token - it reaches Dataverse exclusively through `MicrosoftDataverseService` - so it
 * supplies this adapter. The contract exists precisely so a browser host and a token-holding host
 * can satisfy the same engine without either one forking it.
 *
 * It implements the whole contract: `request`/`rows`/`get`/`patch` for row work, `action` for AI
 *  Builder prediction, and `file`/`putFile` so corpora and evidence can be frozen here rather than
  * only on the token-holding host. Uploads use the connector's file operation with a byte body.
 *
 * **Unsupported cases throw rather than degrade.** The one conditional header the engine relies on,
 * `If-None-Match: *`, is emulated faithfully by creating with a client-supplied primary key so the
 * key itself rejects the loser of a race. Any other conditional header is refused, because silently
 * dropping it would turn a conditional write into an overwrite - it would appear to work while
 * destroying the write-once guarantee the reservation depends on.
 */

import { MicrosoftDataverseService } from '../../../data';
import type { EngineTransport } from '../engine/contracts/transport';
import { DataverseHttpError } from './dataverse-http';

/** The connector resolves the caller's own environment under this literal. */
const ORGANIZATION = 'current';

/**
 * Tables read from the environment being reviewed, rather than the one this app runs in.
 *
 * An agent and its components live wherever they were authored. Everything else the pipeline
 * touches - orchestration rows, the archive, review jobs, results - belongs to the environment
 * hosting this app and must stay there no matter which agent is under review. Sending the archive
 * to the reviewed environment would scatter one review's evidence across two tenants.
 *
 * Routing by table keeps that split in exactly one place. The pipeline goes on addressing rows the
 * OData way and never learns that two environments are involved, so nothing forks to support this.
 *
 * `conversationtranscripts` is deliberately absent. Runtime analysis is performed by a Dataverse
 * plugin, whose `IOrganizationService` only ever reaches its own organization, so transcripts must
 * be counted in the same environment that will analyse them. Reading a reviewed environment's
 * transcript count here would promise runtime results the plugin cannot produce; leaving it on
 * `current` makes the pre-flight count return zero, which is what actually happens.
 *
 * These two are read-only here; the app never writes an agent or a component.
 */
const SOURCE_TABLES = new Set(['bots', 'botcomponents']);
const PREFER = '';
const ACCEPT = 'application/json';

/**
 * Everything the review engine needs from a host that has no bearer token.
 *
 * An alias, not a second contract: the adapter implements the engine's own transport shape exactly,
 * so a change to what the engine needs is a compile error here rather than a runtime surprise.
 */
export type ConnectorTransport = EngineTransport;

/** Bounds pagination so a mis-filtered query fails loudly instead of walking a whole table. */
const MAX_PAGES = 100;

type Row = Record<string, unknown>;

interface OperationResult {
  success?: boolean;
  data?: unknown;
  error?: unknown;
}

/**
 * Preserve the HTTP status, because the pipeline branches on it.
 *
 * The archive treats 404 as "not reserved yet" and 412 as "someone else reserved it first". If those
 * arrived as plain errors, a first-time capture would look like a hard failure instead of a normal
 * cold start, so the status has to survive the trip through the connector.
 */
function fail(result: OperationResult, operation: string): Error {
  const value = result.error ?? result.data;
  if (value && typeof value === 'object') {
    const detail = value as { message?: unknown; status?: unknown; code?: unknown };
    const status = typeof detail.status === 'number' ? detail.status : 0;
    const message = typeof detail.message === 'string'
      ? detail.message
      : `The review pipeline could not complete ${operation}.`;
    if (status) return new DataverseHttpError(status, typeof detail.code === 'string' ? detail.code : undefined, message);
    return new Error(message);
  }
  return new Error(`The review pipeline could not complete ${operation}. Check the connection and table privileges.`);
}

function object(value: unknown, what: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} is malformed.`);
  return value as Row;
}

/**
 * Split `set(id)?query` or `set?query` into its parts.
 *
 * The pipeline addresses rows the OData way because that is what the Web API takes. The connector
 * wants the entity set, the row id and the query options as separate arguments, so the one has to be
 * taken apart to produce the other.
 */
function parse(path: string): { entitySet: string; recordId?: string; query: URLSearchParams } {
  const [resource, search = ''] = path.split('?', 2);
  const match = /^([A-Za-z_][\w]*)(?:\(([^)]+)\))?$/.exec(resource.trim());
  if (!match) throw new Error(`The review pipeline used a Dataverse path this app cannot route: ${resource}`);
  const recordId = match[2]?.replace(/^'|'$/g, '');
  return { entitySet: match[1], ...(recordId ? { recordId } : {}), query: new URLSearchParams(search) };
}

/**
 * Classify the conditional headers the pipeline sends.
 *
 * A conditional header changes what a write *means*, so it can never be dropped silently.
 * `If-None-Match: *` is the archive's reservation - "create this exact row, or tell me it already
 * exists" - and the connector can express that faithfully by creating with a client-supplied key and
 * letting the primary key reject the loser. Anything else still throws, because guessing at
 * concurrency semantics is how write-once guarantees quietly disappear.
 */
function conditionalMode(headers: unknown): 'create-if-absent' | undefined {
  if (headers === undefined) return undefined;
  const entries = [...new Headers(headers as HeadersInit).entries()].filter(([name]) => name.startsWith('if-'));
  if (!entries.length) return undefined;
  if (entries.length === 1 && entries[0][0] === 'if-none-match' && entries[0][1] === '*') return 'create-if-absent';
  throw new Error(
    `This app cannot honour ${entries.map(([name]) => name).join(', ')} - the Dataverse connector has no ` +
    'equivalent, and ignoring it would turn a conditional write into an overwrite.',
  );
}

/** Decode a connector file payload; the connector exchanges base64 text where the Web API uses bytes. */
function fromBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new Error('The stored file did not come back as base64 text.');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The bytes of a file upload, in the form the connector's file operation takes. */
async function toBytes(content: string | Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new Uint8Array(await content.arrayBuffer());
}

/** Does the row already exist? A 404 is the normal cold-start answer, not a failure. */
async function exists(organization: string, entitySet: string, recordId: string): Promise<boolean> {
  const result: OperationResult = await MicrosoftDataverseService.GetItemWithOrganization(
    PREFER, ACCEPT, organization, entitySet, recordId, false, false,
  );
  if (result.success) return true;
  const error = fail(result, `the lookup of ${entitySet}`);
  if (error instanceof DataverseHttpError && error.status === 404) return false;
  throw error;
}

/** Dataverse reports a client-supplied key collision as a duplicate-record condition. */
function isDuplicate(result: OperationResult, error: Error): boolean {
  if (error instanceof DataverseHttpError && (error.status === 412 || error.status === 409)) return true;
  const detail = result.error as { code?: unknown } | undefined;
  if (typeof detail?.code === 'string' && /0x80040237|DuplicateRecord/i.test(detail.code)) return true;
  return /duplicate|already exists/i.test(error.message);
}

/**
 * Build the transport for one review.
 *
 * `organizationUrl` is the environment the **reviewed agent** lives in, which may not be the one
 * this app runs in. It is reported as `organization` because the pipeline compares that against the
 * environment recorded on captured inputs - the check that stops a snapshot captured in one
 * environment being scored against another - and it routes reads of `SOURCE_TABLES`.
 */
export function createConnectorTransport(organizationUrl: string): ConnectorTransport {
  const origin = new URL(organizationUrl).origin;

  /** The reviewed agent is read from its own environment; everything else stays here. */
  const organizationFor = (entitySet: string): string =>
    SOURCE_TABLES.has(entitySet.toLowerCase()) ? origin : ORGANIZATION;

  const transport: ConnectorTransport = {
    organization: origin,

    /**
     * Invoke a bound action, in the environment that owns the table.
     *
     * AI Builder models live where this app is installed, not where the reviewed agent was authored.
     * `msdyn_aimodels` is deliberately absent from `SOURCE_TABLES`, so the routing above already
     * sends prediction here — a reviewed environment may have no models provisioned at all.
     */
    async action(entitySet, actionName, recordId, payload) {
      const result: OperationResult = await MicrosoftDataverseService.PerformBoundActionWithOrganization(
        organizationFor(entitySet), entitySet, actionName, recordId, payload ?? {},
      );
      if (!result.success) throw fail(result, `the ${actionName} action on ${entitySet}`);
      return { status: 200, etag: null, data: result.data };
    },

    async request(method, path, body, headers) {
      const mode = conditionalMode(headers);
      const { entitySet, recordId } = parse(path);
      const item = body === undefined ? {} : object(body, 'The record being written');

      if (method === 'PATCH') {
        if (!recordId) throw new Error('Updating a record requires its identifier.');

        if (mode === 'create-if-absent') {
          // The row carries its own key, so the primary key - not a header - decides the race.
          if (await exists(organizationFor(entitySet), entitySet, recordId)) {
            throw new DataverseHttpError(412, undefined, 'The record already exists.');
          }
          const created: OperationResult = await MicrosoftDataverseService.CreateRecordWithOrganization(
            PREFER, ACCEPT, organizationFor(entitySet), entitySet, item, false,
          );
          if (!created.success) {
            const error = fail(created, `the reservation of ${entitySet}`);
            // A concurrent reservation lands as a duplicate key; that is the 412 the caller expects.
            if (isDuplicate(created, error)) throw new DataverseHttpError(412, undefined, 'The record already exists.');
            throw error;
          }
          return { status: 204, etag: null, data: created.data };
        }

        const result: OperationResult = await MicrosoftDataverseService.UpdateRecordWithOrganization(
          PREFER, ACCEPT, organizationFor(entitySet), entitySet, recordId, item, false,
        );
        if (!result.success) throw fail(result, `the update to ${entitySet}`);
        return { status: 204, etag: null, data: result.data };
      }

      if (method === 'POST') {
        if (recordId) throw new Error('Creating a record cannot target an existing identifier.');
        const result: OperationResult = await MicrosoftDataverseService.CreateRecordWithOrganization(
          PREFER, ACCEPT, organizationFor(entitySet), entitySet, item, false,
        );
        if (!result.success) throw fail(result, `the insert into ${entitySet}`);
        return { status: 204, etag: null, data: result.data };
      }

      throw new Error(`This app cannot issue ${method} through the Dataverse connector.`);
    },

    async get(path) {
      const { entitySet, recordId, query } = parse(path);
      if (!recordId) return { value: await transport.rows(path) };
      const result: OperationResult = await MicrosoftDataverseService.GetItemWithOrganization(
        PREFER, ACCEPT, organizationFor(entitySet), entitySet, recordId, false, false,
        query.get('$select') ?? undefined, query.get('$expand') ?? undefined,
      );
      if (!result.success) throw fail(result, `the read of ${entitySet}`);
      return result.data;
    },

    async patch(path, body, etag) {
      const { entitySet, recordId } = parse(path);
      if (!recordId) throw new Error('Updating a record requires its identifier.');
      const item = object(body, 'The record being written');
      const result: OperationResult = etag === undefined
        ? await MicrosoftDataverseService.UpdateRecordWithOrganization(
          PREFER, ACCEPT, organizationFor(entitySet), entitySet, recordId, item, false)
        : await MicrosoftDataverseService.UpdateOnlyRecordWithOrganization(
          PREFER, ACCEPT, etag, organizationFor(entitySet), entitySet, recordId, item, false);
      if (!result.success) throw fail(result, `the update to ${entitySet}`);
    },

    async file(path, maximumBytes = 16 * 1024 * 1024) {
      // `set(id)/column/$value` - the Web API spelling the pipeline uses for a file column.
      const match = /^([a-z][\w]*)\(([^)]+)\)\/([a-z][\w]*)(?:\/\$value)?$/i.exec(path.trim());
      if (!match) throw new Error(`The review pipeline used a file path this app cannot route: ${path}`);
      const result: OperationResult = await MicrosoftDataverseService.GetEntityFileImageFieldContentWithOrganization(
        '', organizationFor(match[1]), match[1], match[2], match[3],
      );
      if (!result.success) throw fail(result, `the download of ${match[3]}`);
      const bytes = fromBase64(result.data);
      if (bytes.byteLength > maximumBytes) throw new Error('Dataverse response exceeds the configured byte limit.');
      return bytes;
    },

    async putFile(entitySet, id, column, filename, content) {
      if (organizationFor(entitySet) !== ORGANIZATION) {
        throw new Error(`This app never writes to ${entitySet}; it lives in the reviewed environment.`);
      }
      // The managed data client sends a byte body as `application/octet-stream`, so the connector's
      // file operation stores it as-is instead of parsing it as JSON.
      const result: OperationResult = await MicrosoftDataverseService.UpdateEntityFileImageFieldContentWithOrganization(
        'application/octet-stream', ORGANIZATION, entitySet, id, column, await toBytes(content), filename,
      );
      if (!result.success) throw fail(result, `the upload of ${column}`);
    },

    async rows(path, maximum = 10_000) {
      if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Collection limit must be a positive integer.');
      const { entitySet, recordId, query } = parse(path);
      if (recordId) throw new Error('A collection read cannot address a single row.');

      const top = query.get('$top');
      const result: OperationResult = await MicrosoftDataverseService.ListRecordsWithOrganization(
        organizationFor(entitySet), entitySet, PREFER, ACCEPT, false, false,
        query.get('$select') ?? undefined,
        query.get('$filter') ?? undefined,
        query.get('$orderby') ?? undefined,
        query.get('$expand') ?? undefined,
        undefined,
        top === null ? undefined : Number(top),
      );
      if (!result.success) throw fail(result, `the read of ${entitySet}`);

      const rows: Row[] = [];
      let page = object(result.data, 'The Dataverse collection');
      for (let visited = 0; ; visited += 1) {
        if (!Array.isArray(page.value)) throw new Error('Dataverse collection has no value array.');
        if (rows.length + page.value.length > maximum) {
          throw new Error(`Dataverse collection exceeds the explicit ${maximum}-row limit.`);
        }
        rows.push(...page.value.map(value => object(value, 'Dataverse row')));

        const next = page['@odata.nextLink'];
        if (next === undefined) return rows;
        if (typeof next !== 'string') throw new Error('Next-page URL is malformed.');
        if (visited >= MAX_PAGES) throw new Error(`Dataverse pagination exceeded ${MAX_PAGES} pages.`);

        const following: OperationResult = await MicrosoftDataverseService.ListNextPageWithOrganization(
          organizationFor(entitySet), entitySet, next, {
            select: query.get('$select') ?? undefined,
            filter: query.get('$filter') ?? undefined,
            orderby: query.get('$orderby') ?? undefined,
            expand: query.get('$expand') ?? undefined,
          },
        );
        if (!following.success) throw fail(following, `the next page of ${entitySet}`);
        page = object(following.data, 'The Dataverse page');
      }
    },
  };

  return transport;
}
