/**
 * Helpers for describing Dataverse metadata as plain data.
 *
 * Definitions only — no fetch, no Node globals — so schema modules built on these stay
 * browser-safe and can be imported by app code that needs to know a column's shape.
 * The scripts that POST them are a Node concern and live under `scripts/`.
 */

export type Json = Record<string, unknown>;

/** Dataverse wants every user-facing string as a localized label collection. */
export function label(value: string): Json {
  return { LocalizedLabels: [{ Label: value, LanguageCode: 1033 }] };
}

/** Fields every attribute definition carries, whatever its type. */
export function attributeBase(schemaName: string, name: string, description?: string): Json {
  return {
    SchemaName: schemaName,
    DisplayName: label(name),
    RequiredLevel: { Value: 'None' },
    ...(description ? { Description: label(description) } : {}),
  };
}

const common = attributeBase;

export function text(schemaName: string, name: string, maxLength: number, description?: string): Json {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    ...common(schemaName, name, description),
    MaxLength: maxLength,
    FormatName: { Value: 'Text' },
  };
}

export function memo(schemaName: string, name: string, maxLength: number, description?: string): Json {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
    ...common(schemaName, name, description),
    MaxLength: maxLength,
    Format: 'Text',
  };
}

export function integer(
  schemaName: string, name: string, min: number, max: number, description?: string,
): Json {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
    ...common(schemaName, name, description),
    MinValue: min,
    MaxValue: max,
    Format: 'None',
  };
}

/**
 * A local option set.
 *
 * Values are chosen once and never renumbered: a stored row keeps the integer, so
 * changing what a number means silently rewrites history. Adding a value is safe;
 * reusing one is not.
 */
export function choice(
  table: string,
  schemaName: string,
  name: string,
  options: readonly (readonly [number, string])[],
  description?: string,
): Json {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
    ...common(schemaName, name, description),
    OptionSet: {
      '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata',
      OptionSetType: 'Picklist',
      IsGlobal: false,
      Name: `${table}_${schemaName}`,
      DisplayName: label(name),
      Options: options.map(([Value, optionLabel]) => ({ Value, Label: label(optionLabel) })),
    },
  };
}

/**
 * The harness that produced an agent, and therefore which review path applies.
 *
 * Declared once and shared by every table that records it, so a row written by the
 * engine and a row written by the review job cannot drift apart. All four are present
 * from the outset: a later slice adds rows, not schema.
 */
export const HARNESS_OPTIONS = [
  [1, 'Standard'],
  [2, 'Copilot'],
  [3, 'DeclarativeAgent'],
  [4, 'Skill'],
] as const satisfies readonly (readonly [number, string])[];

export const Harness = {
  Standard: 1,
  Copilot: 2,
  DeclarativeAgent: 3,
  Skill: 4,
} as const;

export type HarnessValue = (typeof Harness)[keyof typeof Harness];
