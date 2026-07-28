export interface FieldReferenceSegment {
  key: string;
  each: boolean;
}

export interface SetFieldReferenceOptions {
  schema?: unknown;
  allowArrayAppend?: boolean;
}

const FIELD_PATH_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_:-]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_:-]*(?:\[\])?)*$/;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/u;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export function isValidFieldReference(value: unknown): value is string {
  return typeof value === "string"
    && (FIELD_PATH_PATTERN.test(value) || JSON_POINTER_PATTERN.test(value));
}

export function parseFieldReference(reference: string): FieldReferenceSegment[] | null {
  if (!isValidFieldReference(reference)) return null;
  if (reference.startsWith("/")) {
    return reference.slice(1).split("/").map((token) => ({
      key: token.replace(/~1/g, "/").replace(/~0/g, "~"),
      each: false,
    }));
  }
  return reference.split(".").map((token) => ({
    key: token.endsWith("[]") ? token.slice(0, -2) : token,
    each: token.endsWith("[]"),
  }));
}

export function fieldReferenceTargetsTopLevel(reference: string, fieldName: string): boolean {
  const segments = parseFieldReference(reference);
  return segments?.length === 1 && segments[0].key === fieldName && !segments[0].each;
}

export function getFieldReferenceValue(
  source: unknown,
  reference: string,
): { present: boolean; value: unknown } {
  const values = getFieldReferenceValues(source, reference);
  return values.length === 0
    ? { present: false, value: undefined }
    : { present: true, value: values[0] };
}

export function getFieldReferenceValues(source: unknown, reference: string): unknown[] {
  const segments = parseFieldReference(reference);
  if (!segments) return [];
  const pointer = reference.startsWith("/");
  let current: unknown[] = [source];

  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      const selected = selectChild(value, segment.key, pointer);
      if (!selected.present) continue;
      if (segment.each) {
        if (Array.isArray(selected.value)) next.push(...selected.value);
      } else {
        next.push(selected.value);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

export function setFieldReferenceValue(
  target: Record<string, unknown>,
  reference: string,
  value: unknown,
  options: SetFieldReferenceOptions = {},
): void {
  const segments = parseFieldReference(reference);
  if (!segments || segments.length === 0) {
    throw new Error(`Invalid field reference "${reference}"`);
  }
  if (segments.some((segment) => segment.each)) {
    throw new Error(`Cannot assign through array selector "${reference}"`);
  }

  let current: unknown = target;
  let currentSchema = options.schema;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const last = index === segments.length - 1;

    if (Array.isArray(current)) {
      const arrayIndex = parseArrayIndex(segment.key);
      if (arrayIndex === null) {
        throw new Error(`Cannot use "${segment.key}" as an array index in "${reference}"`);
      }
      if (last) {
        if (arrayIndex < current.length) current[arrayIndex] = value;
        else if (options.allowArrayAppend && arrayIndex === current.length) current.push(value);
        else throw new Error(`Array index ${arrayIndex} does not exist in "${reference}"`);
        return;
      }
      if (arrayIndex >= current.length) {
        throw new Error(`Array index ${arrayIndex} does not exist in "${reference}"`);
      }
      current = current[arrayIndex];
      currentSchema = schemaItems(currentSchema);
      continue;
    }

    if (!isRecord(current)) {
      throw new Error(`Cannot assign through a non-object value in "${reference}"`);
    }
    const childSchema = schemaProperty(currentSchema, segment.key);
    if (last) {
      setOwnProperty(current, segment.key, value);
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(current, segment.key)) {
      const nextValue = isArraySchema(childSchema) ? [] : {};
      setOwnProperty(current, segment.key, nextValue);
    } else if (!isRecord(current[segment.key]) && !Array.isArray(current[segment.key])) {
      throw new Error(`Cannot assign through non-container field "${segment.key}" in "${reference}"`);
    }
    current = current[segment.key];
    currentSchema = childSchema;
  }
}

export function schemaDeclaresFieldReference(schema: unknown, reference: string): boolean {
  const segments = parseFieldReference(reference);
  if (!segments) return false;
  const pointer = reference.startsWith("/");
  let current = schema;

  for (const segment of segments) {
    if (pointer && isArraySchema(current)) {
      if (parseArrayIndex(segment.key) === null) return false;
      current = schemaItems(current);
      if (current === undefined) return false;
      continue;
    }
    const child = schemaProperty(current, segment.key);
    if (child === undefined) return false;
    current = child;
    if (segment.each) {
      current = schemaItems(current);
      if (current === undefined) return false;
    }
  }
  return true;
}

function selectChild(
  value: unknown,
  key: string,
  pointer: boolean,
): { present: boolean; value?: unknown } {
  if (Array.isArray(value) && pointer) {
    const index = parseArrayIndex(key);
    return index !== null && index < value.length
      ? { present: true, value: value[index] }
      : { present: false };
  }
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) {
    return { present: false };
  }
  return { present: true, value: value[key] };
}

function parseArrayIndex(token: string): number | null {
  if (!ARRAY_INDEX_PATTERN.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
}

function schemaProperty(schema: unknown, key: string): unknown {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  return Object.prototype.hasOwnProperty.call(schema.properties, key)
    ? schema.properties[key]
    : undefined;
}

function schemaItems(schema: unknown): unknown {
  return isRecord(schema) && Object.prototype.hasOwnProperty.call(schema, "items")
    ? schema.items
    : undefined;
}

function isArraySchema(schema: unknown): boolean {
  return isRecord(schema) && schema.type === "array";
}

function setOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
