/**
 * Raw `botcomponents` row -> ART's `BotComponent`.
 *
 * The one place the engine crosses from the Web API's JSON into ART's contract, so it is the one
 * place the two disagree about types. Both capture paths go through it; ART's own `BotService`
 * performs the same normalisation when it reads components for the maker app.
 */

import type { DataverseRow } from '../contracts/transport';
import type { BotComponent } from '../scoring/art-ports';

function text(row: DataverseRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map a raw `botcomponents` row onto ART's contract.
 *
 * Two columns need converting, and both are load-bearing:
 *
 * - `componenttype` is an integer choice column, so the Web API returns the *number* `9`. ART
 *   declares `BotComponent.componenttype` as a `string` and compares it against the string literals
 *   `'9'`, `'15'` and so on, so an unconverted row matches nothing: ART's parser then reports zero
 *   topics, zero tools and no agent instructions for an agent that plainly has all three, and the
 *   instruction stage fails for want of an input. The copilot parser happens to survive this because
 *   it compares with `String(...)` at the call site; the standard rubric does not. The conversion
 *   below is ART's own, from `BotService`: absent and null both become `''`, which matches no
 *   component type, rather than being left to sit in a field the contract promises is a string.
 * - `modifiedon` becomes a `Date`, which is what the parser and the bundle assembler expect; the
 *   Web API returns an ISO string.
 *
 * The cast that follows is narrow by construction — these two fields are exactly what the spread
 * cannot get right on its own.
 */
export function toComponent(row: DataverseRow): BotComponent {
  const modifiedon = text(row, 'modifiedon');
  return {
    ...row,
    componenttype: String(row['componenttype'] ?? ''),
    ...(modifiedon ? { modifiedon: new Date(modifiedon) } : {}),
  } as unknown as BotComponent;
}
