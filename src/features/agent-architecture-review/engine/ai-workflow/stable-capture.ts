import { captureAgent, type AgentCapture } from '../capture/agent-capture';
import type { DataverseRow, EngineTransport } from '../contracts/transport';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_METADATA = ['botid', 'versionnumber'];
const COMPONENT_METADATA = [
  'botcomponentid', 'versionnumber', '_parentbotid_value', '_parentbotcomponentid_value',
  'componenttype', 'filedata',
];

interface RowMetadata {
  version: string;
  parentId?: string;
  componentType?: string;
  fileId?: string;
}

type Population = Map<string, RowMetadata>;
interface Observation {
  method: 'get' | 'rows';
  path: string;
  population: Population;
  parentId?: string;
  maximum?: number;
}

function fail(message: string): never {
  throw new Error(`Stable source capture failed: ${message}`);
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) fail(`${label} is not a Dataverse id.`);
  return value.toLowerCase();
}

function object(value: unknown): DataverseRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('A source row is missing or malformed.');
  return value as DataverseRow;
}

function version(row: DataverseRow, label: string): string {
  const etag = row['@odata.etag'];
  const validEtag = typeof etag === 'string' && /^(?:W\/)?"[^"\s]+"$/.test(etag) ? etag : null;
  const number = row.versionnumber;
  const validNumber = typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? String(number)
    : typeof number === 'string' && /^[1-9][0-9]*$/.test(number) ? number : null;
  if (!validEtag && !validNumber) {
    fail(`${label} has no usable @odata.etag or versionnumber; modifiedon is not a version guarantee.`);
  }
  // Keep both when available, rather than overlook a changed versionnumber behind a stale ETag.
  return JSON.stringify([validEtag, validNumber]);
}

function select(path: string, columns: string[], metadataOnly = false): string {
  const [resource, search] = path.split('?', 2);
  const query = new URLSearchParams(search);
  const existing = metadataOnly ? [] : (query.get('$select')?.split(',') ?? []);
  query.set('$select', [...new Set([...existing, ...columns])].join(','));
  return `${resource}?${query.toString()}`;
}

function sameRow(left: RowMetadata, right: RowMetadata | undefined): boolean {
  return !!right && left.version === right.version && left.parentId === right.parentId
    && left.componentType === right.componentType && left.fileId === right.fileId;
}

function changed(label: string): never {
  fail(`${label} changed during capture (row version, ownership, file identity or population). Start a new capture explicitly.`);
}

function samePopulation(before: Population, after: Population, label: string): void {
  if (before.size !== after.size) changed(label);
  for (const [key, metadata] of before) {
    if (!sameRow(metadata, after.get(key))) changed(`${label}: ${key}`);
  }
}

function validateConfiguration(value: unknown): void {
  if (typeof value !== 'string') fail('Agent configuration must be a valid JSON object.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('Agent configuration must be a valid JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('Agent configuration must be a valid JSON object.');
  }
}

/**
 * Capture a Standard/Copilot bot for the opt-in AI runtime, without writes or AI submission.
 *
 * This is an optimistic, two-pass check, not a transaction or a source-snapshot guarantee.
 * Every baseline read precedes every verification read, including for empty populations.
 * ETags / lossless row versions must describe current rows and advance on content and file
 * commits. File reads additionally require a captured filedata identity and the owning skill.
 * The same row versions, file identities and query populations are checked after ALL downloads;
 * bytes are downloaded once. modifiedon, publishedon and content hashes are not substitutes.
 *
 * The bound transport must enumerate complete populations and honour Dataverse version/file
 * semantics. This API cannot prove those semantics, detect transient insert/delete phantoms,
 * or fence edits after a row's verification. Missing evidence fails closed, with no retries.
 * Cancellation stops subsequent reads, but EngineTransport cannot cancel an in-flight request.
 *
 * Classification remains ART's agentSettings-presence rule after JSON-object validation.
 * Its bot parser defines no declarative/automation discriminator; package inputs are out of
 * scope rather than guessed from new flags. capturedAt is local verification-completion time,
 * not a server commit time. The caller owns hashing and persisting the resulting capture.
 */
export async function captureStableAgent(
  transport: EngineTransport,
  botId: string,
  signal?: AbortSignal,
): Promise<{ capture: AgentCapture; capturedAt: string }> {
  const organization = transport.organization;
  const check = () => {
    if (signal?.aborted) throw new DOMException('Review cancelled during stable source capture.', 'AbortError');
    if (transport.organization !== organization) fail('The source environment changed during capture.');
  };
  check();
  const bot = id(botId, 'Selected agent id');
  const observations: Observation[] = [];
  let components: Population | undefined;
  const downloadable = new Set<string>();

  async function read<T>(operation: () => Promise<T>): Promise<T> {
    check();
    try {
      return await operation();
    } finally {
      check();
    }
  }

  function botPopulation(value: unknown): Population {
    const row = object(value);
    if (id(row.botid, 'Returned agent id') !== bot) fail('The returned agent is not the selected bot.');
    return new Map([[bot, { version: version(row, `Agent ${bot}`) }]]);
  }

  function componentPopulation(value: unknown, parentId?: string): Population {
    if (!Array.isArray(value)) fail('The component population is missing or malformed.');
    const population: Population = new Map();
    for (const valueRow of value) {
      const row = object(valueRow);
      const key = id(row.botcomponentid, 'Component id');
      if (population.has(key)) fail(`The component population contains duplicate row ${key}.`);
      if (id(row._parentbotid_value, `Component ${key} parent bot`) !== bot) {
        fail(`Component ${key} does not belong to the selected bot.`);
      }
      const parent = row._parentbotcomponentid_value == null
        ? undefined : id(row._parentbotcomponentid_value, `Component ${key} parent component`);
      const componentType = String(row.componenttype ?? '');
      const fileId = typeof row.filedata === 'string' && row.filedata.trim() ? row.filedata : undefined;
      if (parentId && (parent !== parentId || componentType !== '14')) {
        fail(`Resource ${key} is not a file owned by the selected skill ${parentId}.`);
      }
      population.set(key, { version: version(row, `Component ${key}`), parentId: parent, componentType, fileId });
    }
    if (!parentId) {
      for (const [key, metadata] of population) {
        if (metadata.parentId && !population.has(metadata.parentId)) {
          fail(`Component ${key} has a parent outside the captured agent population.`);
        }
      }
    }
    return population;
  }

  const readOnly = async (): Promise<never> => fail('This adapter only permits source reads.');
  const adapter: EngineTransport = {
    organization,
    request: readOnly,
    action: readOnly,
    patch: readOnly,
    putFile: readOnly,
    async get(path) {
      const match = /^bots\(([^)]+)\)\?/.exec(path);
      if (!match || id(match[1], 'Requested agent id') !== bot) fail('Unexpected source agent read.');
      const row = object(structuredClone(await read(() => transport.get(select(path, BOT_METADATA)))));
      validateConfiguration(row.configuration);
      observations.push({
        method: 'get', path: select(path, BOT_METADATA, true), population: botPopulation(row),
      });
      return row;
    },
    async rows(path, maximum) {
      const [table, search] = path.split('?', 2);
      const filter = new URLSearchParams(search).get('$filter') ?? '';
      const owner = /(?:^| and )_parentbotid_value eq ([0-9a-f-]+)(?: and |$)/i.exec(filter);
      const parent = /(?:^| and )_parentbotcomponentid_value eq ([0-9a-f-]+)(?: and |$)/i.exec(filter);
      if (table !== 'botcomponents' || !owner || id(owner[1], 'Query parent bot') !== bot) {
        fail('Unexpected source component population.');
      }
      const parentId = parent ? id(parent[1], 'Query parent component') : undefined;
      if (parentId && !components?.has(parentId)) fail('The resource owner was not captured with the selected bot.');
      const rows = structuredClone(await read(() => transport.rows(select(path, COMPONENT_METADATA), maximum)));
      const population = componentPopulation(rows, parentId);
      if (parentId) {
        for (const [key, metadata] of population) {
          if (!sameRow(metadata, components?.get(key))) changed(`Resource ${key}`);
          if (!metadata.fileId) fail(`Resource ${key} has no filedata identity; file stability cannot be established.`);
          downloadable.add(key);
        }
      } else {
        if (components) samePopulation(components, population, 'Components');
        components = population;
      }
      observations.push({
        method: 'rows', path: select(path, COMPONENT_METADATA, true), population, parentId, maximum,
      });
      return rows;
    },
    async file(path, maximumBytes) {
      const match = /^botcomponents\(([^)]+)\)\/filedata\/\$value$/.exec(path);
      if (!match || !downloadable.has(id(match[1], 'File component id'))) {
        fail('File ownership and a version-covered filedata identity must be established before downloading.');
      }
      return (await read(() => transport.file(path, maximumBytes))).slice();
    },
  };

  const capture = await captureAgent(adapter, botId, signal);
  check();
  // No verification may interleave with capture: a later skill's download can change an earlier one.
  for (const observation of observations) {
    const current = observation.method === 'get'
      ? botPopulation(await read(() => transport.get(observation.path)))
      : componentPopulation(
        await read(() => transport.rows(observation.path, observation.maximum)), observation.parentId,
      );
    samePopulation(observation.population, current, observation.method === 'get' ? 'Agent' : 'Components');
  }
  check();
  return { capture, capturedAt: new Date().toISOString() };
}
