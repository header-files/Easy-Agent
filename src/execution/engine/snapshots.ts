import { types } from 'node:util';

/** Copy supported data graphs; arbitrary external capabilities remain opaque references. */
export function snapshot<T>(
  value: T,
  materialized?: WeakMap<object, object>,
): T {
  return copy(value, new WeakMap<object, unknown>(), materialized) as T;
}

export function recordSnapshot<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(value) === null ? null : Object.prototype,
  ) as Record<string, unknown>;
  const seen = new WeakMap<object, unknown>([[value, result]]);
  properties(value, result, seen);
  return result as T;
}

const typedArrays = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
];

function properties(
  source: object,
  target: object,
  seen: WeakMap<object, unknown>,
  materialized?: WeakMap<object, object>,
  omit = new Set<PropertyKey>(),
): void {
  for (const key of Reflect.ownKeys(source)) {
    if (omit.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if ('value' in descriptor)
      Object.defineProperty(target, key, {
        value: copy(descriptor.value, seen, materialized),
        writable: true,
        enumerable: descriptor.enumerable ?? false,
        configurable: true,
      });
    else
      Object.defineProperty(target, key, { ...descriptor, configurable: true });
  }
}

function bufferShell(value: ArrayBufferLike): ArrayBufferLike {
  return Object.getPrototypeOf(value) === SharedArrayBuffer.prototype
    ? SharedArrayBuffer.prototype.slice.call(value, 0)
    : ArrayBuffer.prototype.slice.call(value, 0);
}

function copy(
  value: unknown,
  seen: WeakMap<object, unknown>,
  materialized?: WeakMap<object, object>,
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (types.isProxy(value) && !materialized?.has(value)) return value;
  const source = materialized?.get(value) ?? value;
  const prototype: unknown = Object.getPrototypeOf(source);
  let result: object;
  let omit = new Set<PropertyKey>();
  if (Array.isArray(source)) {
    if (prototype !== Array.prototype) return value;
    result = new Array(source.length);
    omit.add('length');
  } else if (prototype === Object.prototype || prototype === null)
    result = Object.create(prototype) as object;
  else if (prototype === Date.prototype)
    result = new Date(Date.prototype.getTime.call(source));
  else if (prototype === Map.prototype) {
    const mapped = new Map<unknown, unknown>();
    seen.set(value, mapped);
    for (const [key, entry] of Map.prototype.entries.call(source) as Iterable<
      [unknown, unknown]
    >)
      mapped.set(
        copy(key, seen, materialized),
        copy(entry, seen, materialized),
      );
    result = mapped;
  } else if (prototype === Set.prototype) {
    const mapped = new Set<unknown>();
    seen.set(value, mapped);
    for (const entry of Set.prototype.values.call(source) as Iterable<unknown>)
      mapped.add(copy(entry, seen, materialized));
    result = mapped;
  } else if (prototype === RegExp.prototype) {
    result = structuredClone(source);
    omit.add('lastIndex');
  } else if (
    prototype === ArrayBuffer.prototype ||
    prototype === SharedArrayBuffer.prototype
  )
    result = bufferShell(source as ArrayBufferLike);
  else if (ArrayBuffer.isView(source)) {
    const rawBuffer = source.buffer;
    const freshBuffer = !seen.has(rawBuffer);
    const buffer = freshBuffer
      ? bufferShell(rawBuffer)
      : (seen.get(rawBuffer) as ArrayBufferLike);
    if (freshBuffer) seen.set(rawBuffer, buffer);
    if (Buffer.isBuffer(source))
      result = Buffer.from(buffer, source.byteOffset, source.byteLength);
    else if (prototype === DataView.prototype)
      result = new DataView(buffer, source.byteOffset, source.byteLength);
    else {
      const Constructor = typedArrays.find(
        (type) => prototype === type.prototype,
      );
      if (!Constructor) return value;
      const View = Constructor as new (
        buffer: ArrayBufferLike,
        offset: number,
        length: number,
      ) => ArrayBufferView;
      result = new View(
        buffer,
        source.byteOffset,
        (source as Uint8Array).length,
      );
    }
    // Register both shells before following custom properties that can point back to the view.
    seen.set(value, result);
    if (freshBuffer) properties(rawBuffer, buffer, seen, materialized);
    omit = new Set(
      Reflect.ownKeys(source).filter(
        (key) => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key),
      ),
    );
  } else return value;
  seen.set(value, result);
  if (prototype === RegExp.prototype)
    Object.defineProperty(result, 'lastIndex', {
      value: copy((source as RegExp).lastIndex, seen, materialized),
      writable: true,
    });
  properties(source, result, seen, materialized, omit);
  return result;
}
