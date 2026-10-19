import { load } from 'js-yaml';
import type { BotComponent } from '../../scoring/art-ports';

const TRANSLATION_COMPONENT_TYPE = '10';
const SETTINGS_COMPONENT_TYPE = '18';
const TEST_COMPONENT_TYPE = '19';
const RESOURCE_COMPONENT_TYPE = '9';

const SETTINGS_ALIASES = new Set(['IvrBotSettings', 'ContentModerationSettings']);
const TEST_ALIASES = new Set(['TestSetDefinition', 'TestCaseDefinition']);
const VOICE_SYSTEM_TRIGGERS = new Set([
  'OnSilence',
  'OnUnrecognizedSpeech',
  'OnAnsweringMachineDetected',
  'OnUnknownDtmfKey',
]);

interface ParsedYaml {
  kind?: unknown;
  beginDialog?: unknown;
}

interface RootKindLine {
  index: number;
  value: string;
  comment?: string;
  hasBom: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function lineEnding(line: string): string {
  const match = line.match(/(?:\r\n|\n|\r)$/);
  return match?.[0] ?? '';
}

function lines(text: string): string[] {
  const result = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  if (result.at(-1) === '') result.pop();
  return result;
}

/** Locate an inline YAML comment without mistaking a `#` inside a quoted scalar for a comment. */
function inlineCommentIndex(value: string): number | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
      return index;
    }
  }
  return undefined;
}

/** Split a plain or quoted scalar from an inline comment without interpreting YAML generally. */
function scalarBeforeComment(value: string): string {
  const commentIndex = inlineCommentIndex(value);
  return (commentIndex === undefined ? value : value.slice(0, commentIndex)).trim();
}

function scalarText(value: string): string {
  const trimmed = scalarBeforeComment(value);
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** Find only an unindented root `kind` entry; nested action kinds are authored evidence. */
function rootKindLine(yaml: string): RootKindLine | undefined {
  const sourceLines = lines(yaml);
  for (let index = 0; index < sourceLines.length; index += 1) {
    const ending = lineEnding(sourceLines[index]);
    const body = sourceLines[index].slice(0, sourceLines[index].length - ending.length);
    const match = body.match(/^\uFEFF?kind\s*:\s*(.*)$/);
    if (!match) continue;
    const commentIndex = inlineCommentIndex(match[1]);
    return {
      index,
      value: scalarText(match[1]),
      ...(commentIndex === undefined ? {} : { comment: match[1].slice(commentIndex) }),
      hasBom: body.startsWith('\uFEFF'),
    };
  }
  return undefined;
}

function withoutRootKind(
  yaml: string,
  shouldRemove: (kind: string) => boolean,
): string {
  const root = rootKindLine(yaml);
  if (!root || !shouldRemove(root.value)) return yaml;
  const sourceLines = lines(yaml);
  const ending = lineEnding(sourceLines[root.index]);
  if (root.comment || root.hasBom) {
    sourceLines[root.index] = `${root.hasBom ? '\uFEFF' : ''}${root.comment ?? ''}${ending}`;
  } else {
    sourceLines.splice(root.index, 1);
  }
  return sourceLines.join('');
}

function indentation(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0;
}

function isBlockScalarIndicator(value: string): boolean {
  return /^[>|](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#.*)?$/.test(value);
}

function isBlockScalarHeader(line: string): boolean {
  const trimmed = line.trimStart();
  if (isBlockScalarIndicator(trimmed)) return true;

  const sequenceValue = trimmed.match(/^-\s+(.+)$/)?.[1];
  if (sequenceValue && isBlockScalarIndicator(sequenceValue)) return true;

  const mappingValue = trimmed.match(/:\s*([>|].*)$/)?.[1];
  return mappingValue ? isBlockScalarIndicator(mappingValue) : false;
}

/**
 * Quote the one invalid scalar shape observed in live connector tools.
 *
 * YAML reserves `@` at the start of a plain scalar. The designer persists output property names
 * such as `@odata.nextLink` unquoted, so js-yaml rejects the whole TaskDialog and ART cannot see its
 * real `action.kind`. This touches only type-9 `propertyName` values and never block-scalar content.
 */
function repairPropertyNameScalars(yaml: string): string {
  const sourceLines = lines(yaml);
  let blockIndent: number | undefined;

  return sourceLines.map((sourceLine) => {
    const ending = lineEnding(sourceLine);
    const body = sourceLine.slice(0, sourceLine.length - ending.length);
    const blank = body.trim().length === 0;
    const indent = indentation(body);

    if (blockIndent !== undefined) {
      if (blank || indent > blockIndent) return sourceLine;
      blockIndent = undefined;
    }
    if (isBlockScalarHeader(body)) {
      blockIndent = indent;
      return sourceLine;
    }

    const match = body.match(/^(\s*(?:-\s+)?propertyName:\s*)(@[^\s#]+)(\s*(?:#.*)?)$/);
    if (!match) return sourceLine;
    return `${match[1]}${JSON.stringify(match[2])}${match[3]}${ending}`;
  }).join('');
}

function parseYaml(yaml: string | undefined): ParsedYaml | undefined {
  if (!yaml?.trim()) return undefined;
  try {
    return record(load(yaml)) as ParsedYaml | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Select the same effective type-9 body ART reads: tools stay on `data`, while a topic whose data
 * is a stale topic copy may be superseded by an AdaptiveDialog in `content`.
 */
function effectiveTypeNineYaml(component: BotComponent): ParsedYaml | undefined {
  const content = component.content?.trim() ? component.content : undefined;
  const data = component.data?.trim() ? component.data : undefined;
  const primary = data ?? content;
  let parsed = parseYaml(primary);

  if (content && data && content !== data && parsed
    && (parsed.kind === 'AdaptiveDialog' || parsed.kind === undefined)) {
    const contentTopic = parseYaml(content);
    if (parsed.kind === 'AdaptiveDialog' || contentTopic?.kind === 'AdaptiveDialog') {
      parsed = contentTopic?.kind === 'AdaptiveDialog' ? contentTopic : undefined;
    }
  }
  return parsed;
}

function isVoiceSystemTopic(component: BotComponent): boolean {
  if (component.componenttype !== RESOURCE_COMPONENT_TYPE) return false;
  const parsed = effectiveTypeNineYaml(component);
  if (parsed?.kind !== 'AdaptiveDialog') return false;
  const trigger = text(record(parsed.beginDialog)?.kind);
  return Boolean(trigger && VOICE_SYSTEM_TRIGGERS.has(trigger));
}

function normalizeYaml(componentType: string, yaml: string): string {
  if (componentType === TRANSLATION_COMPONENT_TYPE) {
    // Localized AdaptiveDialogs are complete topic evidence in the same way ART reads them. Other
    // translated rows are partial overlays (most notably TaskDialogs with no action) and must fall
    // back to type-10 metadata instead of being inventoried as broken standalone components.
    return withoutRootKind(yaml, (kind) => kind !== 'AdaptiveDialog');
  }
  if (componentType === SETTINGS_COMPONENT_TYPE) {
    return withoutRootKind(yaml, (kind) => SETTINGS_ALIASES.has(kind));
  }
  if (componentType === TEST_COMPONENT_TYPE) {
    return withoutRootKind(yaml, (kind) => TEST_ALIASES.has(kind));
  }
  if (componentType === RESOURCE_COMPONENT_TYPE) {
    return repairPropertyNameScalars(yaml);
  }
  return yaml;
}

/**
 * Adapt captured Dataverse rows to ART's component contract without changing ART's rubric.
 *
 * The normalizations are transport/schema repairs only: authoritative component-type metadata wins
 * over partial translation/settings/test aliases, invalid connector YAML is made parseable, and
 * platform-owned voice scaffolding is excluded from the authored topic population.
 */
export function normalizeStandardComponents(
  components: readonly BotComponent[],
): BotComponent[] {
  return components.flatMap((component) => {
    const next: BotComponent = {
      ...component,
      ...(typeof component.content === 'string'
        ? { content: normalizeYaml(component.componenttype, component.content) }
        : {}),
      ...(typeof component.data === 'string'
        ? { data: normalizeYaml(component.componenttype, component.data) }
        : {}),
    };
    return isVoiceSystemTopic(next) ? [] : [next];
  });
}
