/**
 * The Dataverse access this engine needs from its host.
 *
 * Declared here as a pure type rather than imported, because `engine/README.md` forbids anything in
 * this folder from reaching `src/generated/**`. The app's only Dataverse client is the generated
 * `MicrosoftDataverseService`, so the engine cannot construct one — the host builds it and passes it
 * in. `services/connector-transport.ts` is the browser implementation; a Node worker supplies its
 * own, and neither is visible from here.
 *
 * ## Two environments, routed by table
 *
 * An agent and its components live wherever they were authored. Everything else the engine touches —
 * job rows, results, snapshots — belongs to the environment hosting this app and must stay there no
 * matter which agent is under review. Sending a review's evidence to the reviewed environment would
 * scatter one snapshot across two tenants.
 *
 * That routing is the implementation's concern, not this contract's. The engine addresses rows the
 * OData way and never learns two environments are involved, which is what keeps a cross-environment
 * review from forking every call site.
 *
 * ## Paths
 *
 * Every `path` is a Web API resource relative to `api/data/v9.2/` — `bots(<id>)?$select=name`,
 * `cat_agentreviewjobitems?$filter=...`. Entity **set** names, not logical names: `cat_agentreviews`
 * is the logical name but `cat_agentreviewses` is the set, and the difference is a 404 at runtime.
 */

/** A JSON object as returned by the Web API. */
export type DataverseRow = Record<string, unknown>;

/** One Web API response, with the status preserved so callers can branch on it. */
export interface DataverseResponse {
  status: number;
  etag?: string | null;
  data?: unknown;
}

/**
 * Everything the review engine needs from a Dataverse host.
 *
 * Structurally satisfied by the app's `ConnectorTransport`, so the browser host passes its existing
 * client straight in with no adapter.
 */
export interface EngineTransport {
  /** Organization URL of the environment this transport writes to. */
  readonly organization: string;

  /**
   * Execute an exact Web API operation.
   *
   * The engine uses this for creates, because the connector returns the new row's id in the
   * response rather than through a typed helper.
   */
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: HeadersInit,
    timeoutMs?: number,
  ): Promise<DataverseResponse>;

  /**
   * Invoke a bound action on one row.
   *
   * Separate from {@link request} because a bound action is not a record write: it posts to
   * `<set>(<id>)/<action>` and returns a result rather than creating anything. A host that routes
   * writes through a connector cannot express it as a POST — the row id makes it look like a create
   * against an existing key — so it has to be its own operation.
   *
   * AI Builder prediction is the only user today, and it is why the engine needs this at all.
   */
  action(
    entitySet: string,
    actionName: string,
    recordId: string,
    payload?: Record<string, unknown>,
  ): Promise<DataverseResponse>;

  /** Read every row a query matches, following pagination. */
  rows(path: string, maximum?: number): Promise<DataverseRow[]>;

  /** Read one resource. */
  get(path: string): Promise<unknown>;

  /** Update one row. */
  patch(path: string, body: unknown, etag?: string): Promise<void>;

  /** Download a file column. */
  file(path: string, maximumBytes?: number): Promise<Uint8Array>;

  /** Upload a file column. */
  putFile(
    entitySet: string,
    id: string,
    column: string,
    filename: string,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void>;
}
