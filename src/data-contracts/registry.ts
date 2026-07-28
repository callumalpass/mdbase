import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { MdbaseConfig } from "../config/loader.js";
import { dataContractSchema } from "../generated/v03-schemas.js";
import type {
  TypeDefinition,
  V03DataContractImplementation,
  V03SchemaWrapper,
} from "../types/loader.js";

export interface DataContractDefinition {
  kind: "mdbase.contract";
  id: string;
  version: string;
  name?: string;
  description?: string;
  schema: V03SchemaWrapper;
  binding_schema?: V03SchemaWrapper;
  source_paths: string[];
  digest: string;
}

export interface DataContractImplementationDescriptor {
  contract: string;
  version: string;
  contract_digest: string;
  type: string;
  type_version: number;
  implementation_digest: string;
  fields: Record<string, string>;
  binding?: Record<string, unknown>;
  source_path?: string;
}

export interface DataContractDiagnostic {
  code: string;
  message: string;
  severity: "error";
  field?: string;
  path?: string;
}

export interface ContractViewResult {
  valid: boolean;
  contract: string;
  version: string;
  contract_digest: string;
  type: string;
  implementation_digest: string;
  view: Record<string, unknown>;
  diagnostics: DataContractDiagnostic[];
}

export interface DataContractLoadResult {
  valid: boolean;
  registry?: DataContractRegistry;
  error?: { code: string; message: string };
}

interface RegisteredContract {
  definition: DataContractDefinition;
  schemaValidator: ValidateFunction;
  bindingValidator?: ValidateFunction;
}

const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class DataContractRegistry {
  private constructor(
    private readonly contracts: Map<string, RegisteredContract>,
    private readonly implementations: Map<string, DataContractImplementationDescriptor[]>,
  ) {}

  static empty(): DataContractRegistry {
    return new DataContractRegistry(new Map(), new Map());
  }

  static async load(
    collectionRoot: string,
    config: MdbaseConfig,
    typeDefs: Map<string, TypeDefinition>,
  ): Promise<DataContractLoadResult> {
    if (config.spec_profile !== "v0.3") {
      return { valid: true, registry: DataContractRegistry.empty() };
    }

    const contractRoot = path.join(collectionRoot, config.settings.contracts_folder);
    const contracts = new Map<string, RegisteredContract>();
    for (const filePath of await findMarkdownFiles(contractRoot)) {
      const relativePath = path.relative(collectionRoot, filePath).replaceAll("\\", "/");
      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = matter(await fs.promises.readFile(filePath, "utf8")).data as Record<string, unknown>;
      } catch (error) {
        return invalid(
          "invalid_data_contract",
          `Could not parse data contract "${relativePath}": ${(error as Error).message}`,
        );
      }
      if (frontmatter.kind !== "mdbase.contract") continue;

      const metaValidator = createAjv().compile(dataContractSchema);
      if (!metaValidator(frontmatter)) {
        return invalid(
          "invalid_data_contract",
          `Data contract "${relativePath}" is invalid: ${formatAjvErrors(metaValidator.errors)}`,
        );
      }

      const resolvedSchema = await resolveSchemaWrapper(
        frontmatter.schema as V03SchemaWrapper,
        filePath,
        collectionRoot,
        `${String(frontmatter.id)} ${String(frontmatter.version)} schema`,
      );
      if (!resolvedSchema.valid) return resolvedSchema;
      const resolvedBinding = frontmatter.binding_schema
        ? await resolveSchemaWrapper(
            frontmatter.binding_schema as V03SchemaWrapper,
            filePath,
            collectionRoot,
            `${String(frontmatter.id)} ${String(frontmatter.version)} binding_schema`,
          )
        : undefined;
      if (resolvedBinding && !resolvedBinding.valid) return resolvedBinding;

      const portable = {
        kind: "mdbase.contract" as const,
        id: String(frontmatter.id),
        version: String(frontmatter.version),
        schema: resolvedSchema.wrapper!,
        ...(resolvedBinding?.wrapper ? { binding_schema: resolvedBinding.wrapper } : {}),
      };
      const digest = digestCanonical({
        kind: portable.kind,
        id: portable.id,
        version: portable.version,
        schema: resolvedSchema.wrapper!.value,
        ...(resolvedBinding?.wrapper?.value
          ? { binding_schema: resolvedBinding.wrapper.value }
          : {}),
      });
      const identity = contractKey(portable.id, portable.version);
      const existing = contracts.get(identity);
      if (existing) {
        if (existing.definition.digest !== digest) {
          return invalid(
            "data_contract_conflict",
            `data contract conflict for "${portable.id}" ${portable.version}: ${existing.definition.source_paths[0]} and ${relativePath} have different digests`,
          );
        }
        existing.definition.source_paths.push(relativePath);
        existing.definition.source_paths.sort();
        continue;
      }

      const ajv = createAjv();
      let schemaValidator: ValidateFunction;
      let bindingValidator: ValidateFunction | undefined;
      try {
        schemaValidator = ajv.compile(resolvedSchema.wrapper!.value!);
        if (resolvedBinding?.wrapper) {
          bindingValidator = ajv.compile(resolvedBinding.wrapper.value!);
        }
      } catch (error) {
        return invalid(
          "invalid_data_contract",
          `Data contract "${relativePath}" contains an invalid JSON Schema: ${(error as Error).message}`,
        );
      }
      contracts.set(identity, {
        definition: {
          ...portable,
          ...(typeof frontmatter.name === "string" ? { name: frontmatter.name } : {}),
          ...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
          source_paths: [relativePath],
          digest,
        },
        schemaValidator,
        bindingValidator,
      });
    }

    const implementations = new Map<string, DataContractImplementationDescriptor[]>();
    for (const typeDef of [...typeDefs.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      for (const implementation of typeDef.implements ?? []) {
        const identity = contractKey(implementation.contract, implementation.version);
        const registered = contracts.get(identity);
        if (!registered) {
          return invalid(
            "data_contract_not_found",
            `Type "${typeDef.name}" implements missing exact data contract "${implementation.contract}" ${implementation.version}`,
          );
        }
        const implementationError = validateImplementation(typeDef, implementation, registered);
        if (implementationError) return invalid(implementationError.code, implementationError.message);
        const descriptor: DataContractImplementationDescriptor = {
          contract: implementation.contract,
          version: implementation.version,
          contract_digest: registered.definition.digest,
          type: typeDef.name,
          type_version: typeDef.version ?? 1,
          implementation_digest: digestImplementation(registered.definition, typeDef, implementation),
          fields: { ...implementation.fields },
          ...(implementation.binding ? { binding: { ...implementation.binding } } : {}),
          ...(typeDef.source_path ? { source_path: typeDef.source_path } : {}),
        };
        const entries = implementations.get(identity) ?? [];
        entries.push(descriptor);
        implementations.set(identity, entries);
      }
    }
    for (const entries of implementations.values()) {
      entries.sort((left, right) => left.type.localeCompare(right.type));
    }
    return { valid: true, registry: new DataContractRegistry(contracts, implementations) };
  }

  listContracts(): DataContractDefinition[] {
    return [...this.contracts.values()]
      .map(({ definition }) => cloneJson(definition))
      .sort((left, right) => (
        left.id.localeCompare(right.id) ||
        left.version.localeCompare(right.version)
      ));
  }

  getImplementations(contract: string, version: string): DataContractImplementationDescriptor[] {
    return cloneJson(this.implementations.get(contractKey(contract, version)) ?? []);
  }

  project(
    typeName: string,
    contract: string,
    version: string,
    effectiveFrontmatter: Record<string, unknown>,
  ): ContractViewResult {
    const identity = contractKey(contract, version);
    const registered = this.contracts.get(identity);
    const implementation = this.implementations.get(identity)?.find((entry) => entry.type === typeName);
    if (!registered || !implementation) {
      const code = registered ? "data_contract_implementation_not_found" : "data_contract_not_found";
      return {
        valid: false,
        contract,
        version,
        contract_digest: registered?.definition.digest ?? "",
        type: typeName,
        implementation_digest: implementation?.implementation_digest ?? "",
        view: {},
        diagnostics: [{
          code,
          message: registered
            ? `Type "${typeName}" does not implement "${contract}" ${version}`
            : `Data contract "${contract}" ${version} was not found`,
          severity: "error",
        }],
      };
    }

    const view: Record<string, unknown> = {};
    for (const [contractField, recordField] of Object.entries(implementation.fields)) {
      const value = getFieldPath(effectiveFrontmatter, recordField);
      if (value.found) setFieldPath(view, contractField, cloneJson(value.value));
    }
    const valid = registered.schemaValidator(view);
    const diagnostics = valid
      ? []
      : (registered.schemaValidator.errors ?? []).map((error) => ({
          code: "data_contract_record_invalid",
          message: `record projected through "${typeName}" does not satisfy "${contract}" ${version}: ${error.instancePath || "/"} ${error.message ?? error.keyword}`,
          severity: "error" as const,
          ...(error.instancePath ? { field: jsonPointerToFieldPath(error.instancePath) } : {}),
        }));
    return {
      valid: diagnostics.length === 0,
      contract,
      version,
      contract_digest: registered.definition.digest,
      type: typeName,
      implementation_digest: implementation.implementation_digest,
      view,
      diagnostics,
    };
  }
}

function validateImplementation(
  typeDef: TypeDefinition,
  implementation: V03DataContractImplementation,
  contract: RegisteredContract,
): { code: string; message: string } | null {
  const contractSchema = contract.definition.schema.value!;
  const typeSchema = typeDef.schema?.value;
  for (const requiredField of getUnconditionalRequiredFields(contractSchema)) {
    if (!(requiredField in implementation.fields)) {
      return {
        code: "data_contract_field_invalid",
        message: `Type "${typeDef.name}" does not map required contract field "${requiredField}"`,
      };
    }
  }
  for (const [contractField, recordField] of Object.entries(implementation.fields)) {
    if (!schemaDeclaresField(contractSchema, contractField)) {
      return {
        code: "data_contract_field_invalid",
        message: `Type "${typeDef.name}" maps contract field "${contractField}", but that contract field is not declared`,
      };
    }
    if (!typeSchema || !schemaDeclaresField(typeSchema, recordField)) {
      return {
        code: "data_contract_field_invalid",
        message: `Type "${typeDef.name}" maps "${contractField}" to "${recordField}", but the record field is not declared`,
      };
    }
  }
  const binding = implementation.binding ?? {};
  if (contract.bindingValidator) {
    if (!contract.bindingValidator(binding)) {
      return {
        code: "data_contract_binding_invalid",
        message: `Type "${typeDef.name}" has invalid binding for "${implementation.contract}" ${implementation.version}: ${formatAjvErrors(contract.bindingValidator.errors)}`,
      };
    }
  } else if (Object.keys(binding).length > 0) {
    return {
      code: "data_contract_binding_invalid",
      message: `Type "${typeDef.name}" supplies a binding, but "${implementation.contract}" ${implementation.version} has no binding_schema`,
    };
  }
  return null;
}

function getUnconditionalRequiredFields(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((field): field is string => typeof field === "string")
    : [];
}

function schemaDeclaresField(schema: Record<string, unknown>, fieldPath: string): boolean {
  let current: unknown = schema;
  for (const rawSegment of fieldPath.split(".")) {
    const array = rawSegment.endsWith("[]");
    const segment = array ? rawSegment.slice(0, -2) : rawSegment;
    if (!isPlainObject(current) || !isPlainObject(current.properties) || !(segment in current.properties)) {
      return false;
    }
    current = current.properties[segment];
    if (array) {
      if (!isPlainObject(current) || !isPlainObject(current.items)) return false;
      current = current.items;
    }
  }
  return true;
}

function digestImplementation(
  contract: DataContractDefinition,
  typeDef: TypeDefinition,
  implementation: V03DataContractImplementation,
): string {
  const typeSemantics = {
    name: typeDef.name,
    ...(typeDef.version !== undefined ? { version: typeDef.version } : {}),
    ...(typeDef.match !== undefined ? { match: typeDef.match } : {}),
    ...(typeDef.schema !== undefined ? { schema: typeDef.schema } : {}),
    ...(typeDef.collection !== undefined ? { collection: typeDef.collection } : {}),
    ...(typeDef.lifecycle !== undefined ? { lifecycle: typeDef.lifecycle } : {}),
  };
  return digestCanonical({
    contract_digest: contract.digest,
    type: typeSemantics,
    implementation,
  });
}

export function dataContractDigest(frontmatter: Record<string, unknown>): string {
  const schema = isPlainObject(frontmatter.schema) && frontmatter.schema.value !== undefined
    ? frontmatter.schema.value
    : frontmatter.schema;
  const bindingSchema = isPlainObject(frontmatter.binding_schema) &&
    frontmatter.binding_schema.value !== undefined
    ? frontmatter.binding_schema.value
    : frontmatter.binding_schema;
  return digestCanonical({
    kind: frontmatter.kind,
    id: frontmatter.id,
    version: frontmatter.version,
    schema,
    ...(bindingSchema !== undefined ? { binding_schema: bindingSchema } : {}),
  });
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not allow non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

async function resolveSchemaWrapper(
  wrapper: V03SchemaWrapper,
  sourceFile: string,
  collectionRoot: string,
  label: string,
): Promise<{ valid: boolean; wrapper?: V03SchemaWrapper; error?: { code: string; message: string } }> {
  let value = wrapper.value;
  if (wrapper.ref) {
    const hashIndex = wrapper.ref.indexOf("#");
    const pathPart = hashIndex === -1 ? wrapper.ref : wrapper.ref.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : wrapper.ref.slice(hashIndex + 1);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(pathPart) || path.isAbsolute(pathPart) || pathPart.length === 0) {
      return invalid("schema_ref_forbidden", `${label} uses forbidden reference "${wrapper.ref}"`);
    }
    const resolvedPath = path.resolve(path.dirname(sourceFile), pathPart);
    const allowedRoots = await getAllowedSchemaRoots(collectionRoot);
    if (!isInsideAnyRoot(resolvedPath, allowedRoots)) {
      return invalid("schema_ref_forbidden", `${label} reference "${wrapper.ref}" escapes the collection`);
    }
    try {
      const realPath = await fs.promises.realpath(resolvedPath);
      const realRoots = await Promise.all(allowedRoots.map(async (root) => {
        try {
          return await fs.promises.realpath(root);
        } catch {
          return path.resolve(root);
        }
      }));
      if (!isInsideAnyRoot(realPath, realRoots)) {
        return invalid("schema_ref_forbidden", `${label} reference "${wrapper.ref}" escapes through a symlink`);
      }
      const document = JSON.parse(await fs.promises.readFile(realPath, "utf8"));
      value = fragment ? resolveJsonPointer(document, fragment) as Record<string, unknown> | undefined : document;
    } catch (error) {
      return invalid("schema_ref_unresolved", `${label} reference "${wrapper.ref}" could not be resolved: ${(error as Error).message}`);
    }
  }
  if (!isPlainObject(value)) return invalid("invalid_data_contract", `${label} must resolve to a JSON Schema object`);
  const externalRef = findExternalRef(value);
  if (externalRef) {
    return invalid(
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(externalRef) || path.isAbsolute(externalRef)
        ? "schema_ref_forbidden"
        : "unsupported_profile",
      `${label} contains unsupported embedded reference "${externalRef}"`,
    );
  }
  const ajv = createAjv();
  if (!ajv.validateSchema(value)) {
    return invalid("invalid_data_contract", `${label} is not a valid JSON Schema: ${formatAjvErrors(ajv.errors)}`);
  }
  return {
    valid: true,
    wrapper: {
      dialect: "json-schema-2020-12",
      value,
      ...(wrapper.ref ? { ref: wrapper.ref } : {}),
    },
  };
}

async function getAllowedSchemaRoots(collectionRoot: string): Promise<string[]> {
  const roots = [path.resolve(collectionRoot)];
  let current = path.resolve(collectionRoot);
  while (true) {
    const canonicalSchemas = path.join(current, "schemas", "v0.3");
    try {
      if ((await fs.promises.stat(canonicalSchemas)).isDirectory()) {
        roots.push(canonicalSchemas);
        break;
      }
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function isInsideAnyRoot(candidate: string, roots: string[]): boolean {
  const resolvedCandidate = path.resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
  });
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  return ajv;
}

function findExternalRef(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findExternalRef(child);
      if (found) return found;
    }
  } else if (isPlainObject(value)) {
    if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) return value.$ref;
    for (const child of Object.values(value)) {
      const found = findExternalRef(child);
      if (found) return found;
    }
  }
  return undefined;
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") files.push(fullPath);
    }
  };
  await walk(root);
  return files;
}

function contractKey(contract: string, version: string): string {
  return `${contract}\0${version}`;
}

function getFieldPath(
  source: Record<string, unknown>,
  fieldPath: string,
): { found: boolean; value?: unknown } {
  let value: unknown = source;
  for (const rawSegment of fieldPath.split(".")) {
    const segment = rawSegment.endsWith("[]") ? rawSegment.slice(0, -2) : rawSegment;
    if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return { found: false };
    value = value[segment];
    if (rawSegment.endsWith("[]") && !Array.isArray(value)) return { found: false };
  }
  return { found: true, value };
}

function setFieldPath(target: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const segments = fieldPath.split(".").map((segment) => segment.endsWith("[]") ? segment.slice(0, -2) : segment);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  return pointer.slice(1).split("/").reduce((current: unknown, rawSegment) => {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) return current[Number(segment)];
    return (current as Record<string, unknown>)[segment];
  }, document);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ");
}

function jsonPointerToFieldPath(pointer: string): string {
  return pointer.replace(/^\//, "").split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function invalid(code: string, message: string): {
  valid: false;
  error: { code: string; message: string };
} {
  return { valid: false, error: { code, message } };
}
