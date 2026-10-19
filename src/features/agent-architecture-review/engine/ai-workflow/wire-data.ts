export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function nonempty(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
