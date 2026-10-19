/**
 * Data access for the managed app.
 *
 * The Power Apps code app this was ported from used Dataverse table data sources and a few connector
 * operations that a managed app does not have. This module keeps the service names the feature code
 * already calls, and runs every one of them through the Dataverse connector instead.
 */

import { getClient, type IOperationResult } from '@microsoft/managed-apps/data';
import dataSources from '../../generated/dataSources';
import { MicrosoftDataverseService as GeneratedDataverseService } from '../../generated';
import type { IGetAllOptions, IGetOptions } from './models/CommonModels';
import type { Cat_architecturereviews } from './models/Cat_architecturereviewsModel';
import type { Cat_architecturereviewresults } from './models/Cat_architecturereviewresultsModel';
import type { Cat_runtimeanalysisjobs } from './models/Cat_runtimeanalysisjobsModel';
import type { Systemusers } from './models/SystemusersModel';

export { getHostContext, type HostContext } from './host';

/** The connector resolves the environment the app runs in under this literal. */
const CURRENT = 'current';
const ACCEPT = 'application/json';
/** Without this, Dataverse saves the row but returns an empty body, and callers lose the new id. */
const RETURN_ROW = 'return=representation';
const MAX_PAGES = 100;

type Row = Record<string, unknown>;

/**
 * `GetOrganizations` is internal to the connector, so the CLI leaves it out of the generated schema.
 * It is declared here so the data client can still call it.
 */
const DATAVERSE = 'commondataserviceforapps';
const baseDataverse = dataSources[DATAVERSE];
const extendedClient = getClient({
  ...dataSources,
  [DATAVERSE]: {
    ...baseDataverse,
    apis: {
      ...baseDataverse.apis,
      GetOrganizations: {
        path: '/{connectionId}/v1.0/$metadata.json/organizations',
        method: 'GET',
        parameters: [{ name: 'connectionId', in: 'path', required: true, type: 'string' }],
        responseInfo: { 200: { type: 'object' }, default: { type: 'void' } },
      },
    },
  },
} as typeof dataSources);

/**
 * The connector, plus the two operations the old app called that the managed schema lacks.
 */
export class MicrosoftDataverseService extends GeneratedDataverseService {
  /** Every environment the user's Dataverse connection can reach. */
  public static async GetOrganizations(): Promise<IOperationResult<{ value?: Row[] }>> {
    return extendedClient.executeAsync<void, { value?: Row[] }>({
      connectorOperation: { tableName: DATAVERSE, operationName: 'GetOrganizations' },
    });
  }

  /**
   * Reads the page after `nextLink`.
   *
   * The connector's next-page operation is not in the managed schema, so this repeats the list call
   * with the `$skiptoken` that the next link carries.
   */
  public static async ListNextPageWithOrganization(
    organization: string,
    entityName: string,
    nextLink: string,
    query: { select?: string; filter?: string; orderby?: string; expand?: string },
  ): Promise<IOperationResult<Record<string, unknown>>> {
    const skipToken = skipTokenOf(nextLink);
    if (!skipToken) throw new Error(`The next page of ${entityName} has no skip token.`);
    return GeneratedDataverseService.ListRecordsWithOrganization(
      organization, entityName, '', ACCEPT, false, false,
      query.select, query.filter, query.orderby, query.expand,
      undefined, undefined, skipToken,
    );
  }
}

function skipTokenOf(nextLink: string): string | undefined {
  try {
    return new URL(nextLink).searchParams.get('$skiptoken') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whole-number columns the feature code writes as strings.
 *
 * The old SDK converted these from table metadata. The connector passes the body through, and
 * Dataverse rejects a string for an integer column, so they are converted here.
 */
const INTEGER_COLUMNS: Record<string, ReadonlySet<string>> = {
  cat_architecturereviews: new Set(['cat_targetcomponentcount']),
  cat_architecturereviewresults: new Set(['cat_artifactversion', 'cat_score', 'cat_sequencenumber']),
  cat_runtimeanalysisjobs: new Set(['cat_chunkindex', 'cat_chunksize', 'cat_jobstatus', 'cat_transcriptsprocessed']),
};

function toWritable(entitySet: string, record: object): Row {
  const integers = INTEGER_COLUMNS[entitySet];
  const item: Row = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    item[key] = integers?.has(key) && typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return item;
}

function failure<T>(result: IOperationResult<unknown>): IOperationResult<T> {
  return result as IOperationResult<T>;
}

/** CRUD over one table, with the same shape the old generated table services had. */
function tableService<T>(entitySet: string) {
  return {
    async create(record: object): Promise<IOperationResult<T>> {
      const result = await GeneratedDataverseService.CreateRecordWithOrganization(
        RETURN_ROW, ACCEPT, CURRENT, entitySet, toWritable(entitySet, record), false,
      );
      return result as unknown as IOperationResult<T>;
    },

    async update(id: string, changedFields: object): Promise<IOperationResult<T>> {
      const result = await GeneratedDataverseService.UpdateRecordWithOrganization(
        RETURN_ROW, ACCEPT, CURRENT, entitySet, id, toWritable(entitySet, changedFields), false,
      );
      return result as unknown as IOperationResult<T>;
    },

    async delete(id: string): Promise<void> {
      await GeneratedDataverseService.DeleteRecordWithOrganization(CURRENT, entitySet, id);
    },

    async get(id: string, options?: IGetOptions): Promise<IOperationResult<T>> {
      const result = await GeneratedDataverseService.GetItemWithOrganization(
        '', ACCEPT, CURRENT, entitySet, id, false, false, options?.select?.join(','),
      );
      return result as unknown as IOperationResult<T>;
    },

    /** Reads every page, so callers get the whole result set as the old SDK returned it. */
    async getAll(options: IGetAllOptions = {}): Promise<IOperationResult<T[]>> {
      const query = {
        select: options.select?.join(','),
        filter: options.filter,
        orderby: options.orderBy?.join(','),
      };
      let result = await GeneratedDataverseService.ListRecordsWithOrganization(
        CURRENT, entitySet, '', ACCEPT, false, false,
        query.select, query.filter, query.orderby, undefined, undefined, options.top,
      );
      const rows: T[] = [];
      for (let page = 0; ; page += 1) {
        if (!result.success) return failure<T[]>(result);
        const data = (result.data ?? {}) as { value?: T[]; '@odata.nextLink'?: string };
        rows.push(...(data.value ?? []));
        const next = data['@odata.nextLink'];
        if (!next || options.top !== undefined || page >= MAX_PAGES) break;
        result = await MicrosoftDataverseService.ListNextPageWithOrganization(CURRENT, entitySet, next, query);
      }
      return { success: true, data: rows } as IOperationResult<T[]>;
    },
  };
}

export const Cat_architecturereviewsService = tableService<Cat_architecturereviews>('cat_architecturereviews');
export const Cat_architecturereviewresultsService =
  tableService<Cat_architecturereviewresults>('cat_architecturereviewresults');
export const Cat_runtimeanalysisjobsService = tableService<Cat_runtimeanalysisjobs>('cat_runtimeanalysisjobs');
export const SystemusersService = tableService<Systemusers>('systemusers');

/**
 * Feature-usage telemetry.
 *
 * The old app ran the "Global | LogFeatureTelemetry I ARC" flow as a data source. Managed apps cannot
 * bind a specific flow yet, so this records nothing. Reviews do not depend on it.
 */
export const Global_LogFeatureTelemetryService = {
  async Run(_input: { text?: string }): Promise<IOperationResult<void>> {
    return { success: true, data: undefined } as IOperationResult<void>;
  },
};
