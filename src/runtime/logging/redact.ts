import { types } from 'node:util';

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 12;
const MAX_ITEMS = 1_000;
const MAX_NODES = 10_000;
const nativeStackGetter = Object.getOwnPropertyDescriptor(
  new Error(),
  'stack',
)?.get;

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    /(?:apikey|token|password|passwd|secret|secretkey|privatekey|accesskey|authorization|cookie|credentials)$/.test(
      normalized,
    ) || ['pwd', 'authorizationheader', 'authentication'].includes(normalized)
  );
}

function dataTextProperty(value: object, key: string): string | undefined {
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor)
        return 'value' in descriptor && typeof descriptor.value === 'string'
          ? descriptor.value
          : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    /* Unusual prototypes are not needed to log a safe error. */
  }
  return undefined;
}

/** Recognizable credentials and configured literal secrets; not a general PII detector. */
export function safeText(
  text: string,
  redactValues: readonly string[] = [],
): string {
  // All detectors inspect the original text. Union their ranges before replacing,
  // so a literal secret cannot corrupt a label or be partially exposed by URL masking.
  const ranges: [number, number][] = [];
  const add = (start: number, end: number): void => {
    if (end > start) ranges.push([start, end]);
  };
  for (const secret of redactValues) {
    if (!secret.length) continue;
    for (
      let start = text.indexOf(secret);
      start !== -1;
      start = text.indexOf(secret, start + 1)
    )
      add(start, start + secret.length);
  }
  for (const match of text.matchAll(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi))
    add(
      match.index + (match[1]?.length ?? 0),
      match.index + match[0].length - 1,
    );
  for (const match of text.matchAll(/([?&])([^=&#\s]+)=([^&#\s]*)/g)) {
    let key = match[2] ?? '';
    try {
      key = decodeURIComponent(key.replace(/\+/g, ' '));
    } catch {
      /* Keep malformed keys as text. */
    }
    if (sensitiveKey(key))
      add(
        match.index + match[0].length - (match[3]?.length ?? 0),
        match.index + match[0].length,
      );
  }
  for (const match of text.matchAll(
    /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi,
  ))
    add(
      match.index + match[0].length - (match[1]?.length ?? 0),
      match.index + match[0].length,
    );
  for (const match of text.matchAll(/\bsk-[A-Za-z0-9_-]{6,}\b/g))
    add(match.index, match.index + match[0].length);
  for (const match of text.matchAll(
    /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*([^\r\n]+)/gi,
  ))
    add(
      match.index + match[0].length - (match[1]?.length ?? 0),
      match.index + match[0].length,
    );

  const labels = /(["']?)([A-Za-z][A-Za-z0-9_.-]{0,127})\1\s*[:=]\s*/g;
  for (let match = labels.exec(text); match; match = labels.exec(text)) {
    if (!sensitiveKey(match[2] ?? '')) continue;
    const start = labels.lastIndex;
    let end = start;
    const quote = text[start];
    if (quote === '"' || quote === "'") {
      end++;
      while (end < text.length) {
        if (text[end] === '\\') end += 2;
        else if (text[end] === quote) break;
        else end++;
      }
      add(start + 1, Math.min(end, text.length));
      labels.lastIndex = Math.min(end + 1, text.length);
    } else {
      while (end < text.length && !/[\r\n,;&}\]]/.test(text[end] ?? '')) end++;
      add(start, end);
      labels.lastIndex = end;
    }
  }

  ranges.sort(([a, aEnd], [b, bEnd]) => a - b || aEnd - bEnd);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1])
      previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  let output = '';
  let copied = 0;
  for (const [start, end] of merged) {
    output += text.slice(copied, start) + REDACTED;
    copied = end;
  }
  return output + text.slice(copied);
}

/** Clone JSON-like fields without invoking user serializers or ordinary getters. */
export function safeFields(
  fields: Readonly<Record<string, unknown>>,
  redactValues: readonly string[] = [],
): Record<string, unknown> {
  const ancestors = new Set<object>();
  let remaining = MAX_NODES;

  const visit = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > MAX_DEPTH) return '[Truncated]';
    if (typeof value === 'string') return safeText(value, redactValues);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number')
      return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object') return '[Unsupported]';
    if (ancestors.has(value)) return '[Circular]';
    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return '[Unserializable]';
    }
    ancestors.add(value);
    try {
      const read = (key: string, descriptor: PropertyDescriptor): unknown => {
        if (sensitiveKey(key)) return REDACTED;
        if ('value' in descriptor) return visit(descriptor.value, depth + 1);
        // V8's native lazy stack is useful diagnostic data; arbitrary getters stay uncalled.
        if (
          types.isNativeError(value) &&
          key === 'stack' &&
          descriptor.get === nativeStackGetter &&
          dataTextProperty(value, 'name') !== undefined &&
          dataTextProperty(value, 'message') !== undefined
        ) {
          try {
            return visit(descriptor.get?.call(value), depth + 1);
          } catch {
            return '[Unreadable]';
          }
        }
        return '[Accessor]';
      };

      if (Array.isArray(value)) {
        const length =
          typeof descriptors.length?.value === 'number'
            ? descriptors.length.value
            : 0;
        const result: unknown[] = [];
        for (let index = 0; index < Math.min(length, MAX_ITEMS); index++) {
          const descriptor = descriptors[String(index)];
          result.push(descriptor ? read(String(index), descriptor) : null);
        }
        if (length > MAX_ITEMS) result.push('[Truncated]');
        return result;
      }

      const result: Record<string, unknown> = {};
      const entries = Object.entries(descriptors).filter(
        ([key, descriptor]) =>
          descriptor.enumerable ||
          (types.isNativeError(value) &&
            ['name', 'message', 'stack', 'cause', 'errors'].includes(key)),
      );
      if (types.isNativeError(value) && !descriptors.name) {
        result.name = safeText(
          dataTextProperty(value, 'name') ?? 'Error',
          redactValues,
        );
      }
      for (const [key, descriptor] of entries.slice(0, MAX_ITEMS)) {
        Object.defineProperty(result, safeText(key, redactValues), {
          value: read(key, descriptor),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (entries.length > MAX_ITEMS) result.truncated = true;
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  const result = visit(fields, 0);
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { value: result };
}
