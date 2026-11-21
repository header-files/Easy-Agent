import { Ajv } from 'ajv';
import type { ToolSpec } from '../../harness/contracts/tool/index.ts';

export function argumentObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validToolName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function invalidSpec(): never {
  throw new Error('Invalid tool specification.');
}

/** Tool schemas are JSON data: no caller getters, serializers or shared references. */
function copyJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!argumentObject(value) && !Array.isArray(value)) return invalidSpec();
  if (ancestors.has(value)) return invalidSpec();
  if (
    !Array.isArray(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalidSpec();
  ancestors.add(value);
  try {
    const descriptors: Record<string, PropertyDescriptor> =
      Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const length: number = descriptors.length?.value;
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) return invalidSpec();
        result.push(copyJson(descriptor.value, ancestors));
      }
      return result;
    }
    const entries = Object.entries(descriptors).filter(
      ([, descriptor]) => descriptor.enumerable,
    );
    return Object.fromEntries(
      entries.map(([key, descriptor]) => {
        if (!('value' in descriptor)) return invalidSpec();
        return [key, copyJson(descriptor.value, ancestors)];
      }),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function copyToolSpec(spec: unknown): ToolSpec {
  try {
    if (
      !argumentObject(spec) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(spec))
    )
      return invalidSpec();
    const descriptors = Object.getOwnPropertyDescriptors(spec);
    const nameField = descriptors.name;
    const descriptionField = descriptors.description;
    const parametersField = descriptors.parameters;
    if (
      !nameField ||
      !('value' in nameField) ||
      !descriptionField ||
      !('value' in descriptionField) ||
      !parametersField ||
      !('value' in parametersField)
    )
      return invalidSpec();
    const name: unknown = nameField.value;
    const description: unknown = descriptionField.value;
    const schema: unknown = parametersField.value;
    if (
      !validToolName(name) ||
      typeof description !== 'string' ||
      !argumentObject(schema)
    )
      return invalidSpec();
    const parameters = copyJson(schema);
    if (!argumentObject(parameters)) return invalidSpec();
    const type = parameters.type;
    if (
      type !== undefined &&
      type !== 'object' &&
      !(Array.isArray(type) && type.includes('object'))
    )
      return invalidSpec();
    return { name, description, parameters };
  } catch {
    return invalidSpec();
  }
}

/** A fresh Ajv instance isolates $id namespaces and never loads remote schemas. */
export function compileToolSchema(
  parameters: Record<string, unknown>,
): (args: Record<string, unknown>) => boolean {
  try {
    const ajv = new Ajv({
      strict: true,
      logger: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      allErrors: false,
    });
    const validate = ajv.compile(parameters);
    if ('$async' in validate && validate.$async === true) throw new Error();
    return (args) => validate(args) === true;
  } catch {
    throw new Error('Invalid or unsupported tool parameters schema.');
  }
}
