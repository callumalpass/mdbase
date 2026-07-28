import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import {
  configSchema,
  dataContractSchema,
  diagnosticSchema,
  operationResultSchema,
  queryResultSchema,
  querySchema,
  typeFileSchema,
  typePackSchema,
  viewSchema,
} from "../generated/v03-schemas.js";

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const schemas = {
  config: configSchema,
  dataContract: dataContractSchema,
  diagnostic: diagnosticSchema,
  operationResult: operationResultSchema,
  query: querySchema,
  queryResult: queryResultSchema,
  typeFile: typeFileSchema,
  typePack: typePackSchema,
  view: viewSchema,
} as const;
const validators = new Map<keyof typeof schemas, ValidateFunction>(
  Object.entries(schemas).map(([name, schema]) => [
    name as keyof typeof schemas,
    ajv.compile(schema),
  ]),
);

export type CanonicalSchemaName = keyof typeof schemas;

export interface CanonicalSchemaValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export function validateCanonicalSchema(
  name: CanonicalSchemaName,
  value: unknown,
): CanonicalSchemaValidationResult {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown canonical schema ${name}.`);
  const valid = validator(value);
  return { valid, errors: valid ? [] : [...(validator.errors ?? [])] };
}

export function getCanonicalSchemas(): Readonly<Record<CanonicalSchemaName, Record<string, unknown>>> {
  return structuredClone(schemas);
}
