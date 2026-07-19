import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";
import { satisfies } from "semver";
import { stringify } from "yaml";
import {
  getCanonicalSchemas,
  type ActionContract,
  type CapabilityContract,
  type EventContract,
  type ExpressionObject,
  type ProviderContract,
  type ProviderRequirement,
  type Requires,
  type RuntimeContractRecord as PortableRuntimeContractRecord,
  type RuntimeDiagnostic as PortableRuntimeDiagnostic,
  type RuntimePolicyContract as PortableRuntimePolicyContract,
  type RuntimeRecordType as PortableRuntimeRecordType,
  type WorkflowContract,
  type WorkflowStep,
  type WorkflowTrigger,
} from "@callumalpass/mdbase-runtime";

export type RuntimeRecordType = PortableRuntimeRecordType;
export type RuntimeSeverity = PortableRuntimeDiagnostic["severity"];
export type RuntimeDiagnostic = PortableRuntimeDiagnostic;

export interface RuntimeMarkdownRecord<T extends Record<string, unknown> = Record<string, unknown>> {
  path: string;
  frontmatter: T;
  body: string;
}

export type RuntimeContractRecord = PortableRuntimeContractRecord;
export type RuntimeRequires = Requires;
export type RuntimeProviderRequirement = ProviderRequirement;
export type RuntimeProviderContract = ProviderContract;
export type RuntimeActionContract = ActionContract;
export type RuntimeEventContract = EventContract;
export type RuntimeCapabilityContract = CapabilityContract;
export type RuntimeExpressionObject = ExpressionObject;
export type RuntimeWorkflowTrigger = WorkflowTrigger;
export type RuntimeWorkflowStep = WorkflowStep;
export type RuntimeWorkflowContract = WorkflowContract;
export type RuntimePolicyContract = PortableRuntimePolicyContract;

export interface RuntimePackage {
  root: string;
  typeFiles: RuntimeMarkdownRecord[];
  records: RuntimeMarkdownRecord<RuntimeContractRecord>[];
  providers: RuntimeMarkdownRecord<RuntimeProviderContract>[];
  actions: RuntimeMarkdownRecord<RuntimeActionContract>[];
  events: RuntimeMarkdownRecord<RuntimeEventContract>[];
  capabilities: RuntimeMarkdownRecord<RuntimeCapabilityContract>[];
  workflows: RuntimeMarkdownRecord<RuntimeWorkflowContract>[];
  policies: RuntimeMarkdownRecord<RuntimePolicyContract>[];
  diagnostics: RuntimeDiagnostic[];
}

export interface RuntimeRegistry {
  providerContracts: Map<string, RuntimeProviderContract>;
  actions: Map<string, RuntimeActionContract>;
  events: Map<string, RuntimeEventContract>;
  capabilities: Map<string, RuntimeCapabilityContract>;
  workflows: Map<string, RuntimeWorkflowContract>;
  policies: Map<string, RuntimePolicyContract>;
  providers: Set<string>;
  capabilityIds: Set<string>;
  selectedPolicyId?: string;
  diagnostics: RuntimeDiagnostic[];
}

export interface RuntimeValidationResult {
  valid: boolean;
  diagnostics: RuntimeDiagnostic[];
}

export interface LoadRuntimeContractsOptions {
  implicitContracts?: RuntimeContractRecord[];
  includeTypeFiles?: boolean;
  selectedPolicyId?: string;
}

const runtimeTypes = new Set<RuntimeRecordType>([
  "provider",
  "action",
  "event",
  "capability",
  "workflow",
  "runtime_policy",
  "runtime_run",
  "runtime_checkpoint",
  "runtime_diagnostic",
]);

let ajv: Ajv2020 | null = null;
let validators: Partial<Record<RuntimeRecordType | "eventEnvelope", ValidateFunction>> | null = null;

export function isRuntimeRecordType(value: unknown): value is RuntimeRecordType {
  return typeof value === "string" && runtimeTypes.has(value as RuntimeRecordType);
}

export function buildRuntimePackage(
  root: string,
  records: RuntimeMarkdownRecord[],
  options: LoadRuntimeContractsOptions = {},
): RuntimePackage {
  const diagnostics: RuntimeDiagnostic[] = [];
  const runtimeRecords: RuntimeMarkdownRecord<RuntimeContractRecord>[] = [];
  const actions: RuntimeMarkdownRecord<RuntimeActionContract>[] = [];
  const providers: RuntimeMarkdownRecord<RuntimeProviderContract>[] = [];
  const events: RuntimeMarkdownRecord<RuntimeEventContract>[] = [];
  const capabilities: RuntimeMarkdownRecord<RuntimeCapabilityContract>[] = [];
  const workflows: RuntimeMarkdownRecord<RuntimeWorkflowContract>[] = [];
  const policies: RuntimeMarkdownRecord<RuntimePolicyContract>[] = [];
  const typeFiles: RuntimeMarkdownRecord[] = [];

  for (const record of records) {
    if (record.path.startsWith("_types/")) {
      if (options.includeTypeFiles !== false) {
        typeFiles.push(record);
      }
      continue;
    }
    const type = record.frontmatter.type;
    if (!isRuntimeRecordType(type)) continue;

    const runtimeRecord = record as RuntimeMarkdownRecord<RuntimeContractRecord>;
    runtimeRecords.push(runtimeRecord);
    diagnostics.push(...validateRuntimeContractRecord(runtimeRecord.frontmatter, runtimeRecord.path));
    switch (type) {
      case "provider":
        providers.push(runtimeRecord as RuntimeMarkdownRecord<RuntimeProviderContract>);
        break;
      case "action":
        actions.push(runtimeRecord as RuntimeMarkdownRecord<RuntimeActionContract>);
        break;
      case "event":
        events.push(runtimeRecord as RuntimeMarkdownRecord<RuntimeEventContract>);
        break;
      case "capability":
        capabilities.push(runtimeRecord as RuntimeMarkdownRecord<RuntimeCapabilityContract>);
        break;
      case "workflow":
        workflows.push(runtimeRecord as RuntimeMarkdownRecord<RuntimeWorkflowContract>);
        break;
      case "runtime_policy":
        policies.push(runtimeRecord as RuntimeMarkdownRecord<RuntimePolicyContract>);
        break;
    }
  }

  return {
    root,
    typeFiles,
    records: runtimeRecords,
    providers,
    actions,
    events,
    capabilities,
    workflows,
    policies,
    diagnostics,
  };
}

export function composeRuntimeRegistry(
  runtimePackage: RuntimePackage,
  implicitContracts: RuntimeContractRecord[] = [],
  selectedPolicyId?: string,
): RuntimeRegistry {
  const registry: RuntimeRegistry = {
    providerContracts: new Map(),
    actions: new Map(),
    events: new Map(),
    capabilities: new Map(),
    workflows: new Map(),
    policies: new Map(),
    providers: new Set(),
    capabilityIds: new Set(),
    selectedPolicyId,
    diagnostics: [...runtimePackage.diagnostics],
  };

  for (const contract of implicitContracts) {
    addRuntimeRecordToRegistry(registry, {
      path: `<implicit:${contract.id}>`,
      frontmatter: contract,
      body: "",
    });
  }
  for (const record of runtimePackage.records) {
    addRuntimeRecordToRegistry(registry, record);
  }
  return registry;
}

export function preflightRuntimeWorkflows(registry: RuntimeRegistry): RuntimeValidationResult {
  const diagnostics = [...registry.diagnostics];
  diagnostics.push(...validateProviderListings(registry));
  for (const workflow of registry.workflows.values()) {
    diagnostics.push(...resolveRequires(registry, workflow.requires, workflow.id));
    diagnostics.push(...duplicatesById(workflow.triggers ?? [], "duplicate_trigger", workflow.id));
    diagnostics.push(...duplicatesById(workflow.steps ?? [], "duplicate_step", workflow.id));

    for (const trigger of workflow.triggers ?? []) {
      if (!registry.events.has(trigger.event)) {
        diagnostics.push(unresolved("unresolved_event", trigger.event, workflow.id));
      }
    }
    for (const step of workflow.steps ?? []) {
      const action = registry.actions.get(step.action);
      if (!action) {
        diagnostics.push(unresolved("unresolved_action", step.action, workflow.id));
        continue;
      }
      diagnostics.push(...resolveRequires(registry, action.requires, action.id));
      diagnostics.push(...resolveRequires(registry, step.requires, workflow.id));
      for (const emitted of action.emits ?? []) {
        if (!registry.events.has(emitted)) {
          diagnostics.push(unresolved("unresolved_emitted_event", emitted, action.id));
        }
      }
    }
    const requiredCapabilities = collectRequiredCapabilities(registry, workflow);
    if (requiredCapabilities.size > 0 && !selectedPolicy(registry)) {
      diagnostics.push({
        severity: "error",
        code: "policy_not_selected",
        message: `Workflow ${workflow.id} can dispatch effectful actions but no runtime policy is selected.`,
        id: workflow.id,
      });
    } else {
      for (const capability of requiredCapabilities) {
        if (selectedPolicy(registry)?.capabilities?.[capability]?.mode === "deny") {
          diagnostics.push({
            severity: "error",
            code: "capability_denied",
            message: `Capability ${capability} is denied by selected runtime policy.`,
            id: capability,
          });
        }
      }
    }
    if (workflow.run && isPlainObject(workflow.run)) {
      const execution = workflow.run.execution;
      if (isPlainObject(execution) && execution.mode === "single_executor" && !selectedExecutor(registry, workflow.id)) {
        diagnostics.push({
          severity: "error",
          code: "executor_not_selected",
          message: `Workflow ${workflow.id} requires a selected executor.`,
          id: workflow.id,
        });
      }
    }
  }
  return result(diagnostics);
}

export function validateRuntimeEventEnvelope(
  registry: RuntimeRegistry,
  envelope: unknown,
): RuntimeValidationResult {
  const envelopeValidator = getValidator("eventEnvelope");
  if (!envelopeValidator) {
    return result([{
      severity: "error",
      code: "unknown_schema",
      message: "Runtime event envelope schema is not available.",
    }]);
  }
  const diagnostics = runValidator(envelopeValidator, envelope, "<event>");
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return result(diagnostics);
  }
  const eventType = (envelope as { type?: unknown }).type;
  if (typeof eventType !== "string") {
    diagnostics.push({
      severity: "error",
      code: "invalid_event_type",
      message: "Event envelope type must be a string.",
    });
    return result(diagnostics);
  }
  const contract = registry.events.get(eventType);
  if (!contract) {
    diagnostics.push(unresolved("unresolved_event", eventType));
    return result(diagnostics);
  }
  const declaredVersion = (envelope as { contract_version?: unknown }).contract_version;
  if (declaredVersion !== contract.version) {
    diagnostics.push({
      severity: "error",
      code: "contract_version_mismatch",
      message: `Event ${eventType} declares contract version ${String(declaredVersion)}, but the registry provides ${String(contract.version)}.`,
      id: eventType,
      details: { expected: contract.version, actual: declaredVersion },
    });
  }
  const sourceProvider = (envelope as { source?: { provider?: unknown } }).source?.provider;
  if (typeof sourceProvider === "string" && typeof contract.provider === "string" && sourceProvider !== contract.provider) {
    diagnostics.push({
      severity: "error",
      code: "event_provider_mismatch",
      message: `Event ${eventType} was delivered by ${sourceProvider}, but its contract belongs to ${contract.provider}.`,
      id: eventType,
    });
  }
  diagnostics.push(
    ...validateRuntimeValueAgainstSchema(
      contract.schemas.payload,
      (envelope as { payload?: unknown }).payload,
      "<event.payload>",
    ).diagnostics,
  );
  return result(diagnostics);
}

export function validateRuntimeActionInput(
  registry: RuntimeRegistry,
  actionId: string,
  input: unknown,
): RuntimeValidationResult {
  const action = registry.actions.get(actionId);
  if (!action) {
    return result([unresolved("unresolved_action", actionId)]);
  }
  return validateRuntimeValueAgainstSchema(action.schemas.input, input, `<action:${actionId}.input>`);
}

export function validateRuntimeActionOutput(
  registry: RuntimeRegistry,
  actionId: string,
  output: unknown,
): RuntimeValidationResult {
  const action = registry.actions.get(actionId);
  if (!action) {
    return result([unresolved("unresolved_action", actionId)]);
  }
  if (action.schemas.output == null) {
    return result([]);
  }
  return validateRuntimeValueAgainstSchema(action.schemas.output, output, `<action:${actionId}.output>`);
}

export function authorizeRuntimeAction(
  registry: RuntimeRegistry,
  actionId: string,
): RuntimeValidationResult {
  const action = registry.actions.get(actionId);
  if (!action) return result([unresolved("unresolved_action", actionId)]);
  const capabilities = new Set([...(action.requires?.capabilities ?? []), ...(action.effects ?? [])]);
  if (capabilities.size === 0) return result([]);
  const policy = selectedPolicy(registry);
  if (!policy) {
    return result([{
      severity: "error",
      code: "policy_not_selected",
      message: `Action ${actionId} has effects but no runtime policy is selected.`,
      id: actionId,
    }]);
  }
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const capability of capabilities) {
    if (policy.capabilities?.[capability]?.mode !== "allow") {
      diagnostics.push({
        severity: "error",
        code: "capability_denied",
        message: `Capability ${capability} is not explicitly allowed by selected policy ${policy.id}.`,
        id: capability,
      });
    }
  }
  return result(diagnostics);
}

export function validateRuntimeValueAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): RuntimeValidationResult {
  const instance = getAjv();
  if (!instance.validateSchema(schema)) {
    return result(schemaDiagnostics(instance.errors, path, "invalid_embedded_schema"));
  }
  try {
    return result(runValidator(instance.compile(schema), value, path));
  } catch (error) {
    return result([{
      severity: "error",
      code: "invalid_embedded_schema",
      message: error instanceof Error ? error.message : "Embedded JSON Schema could not be compiled.",
      path,
    }]);
  }
}

export function materializeRuntimeContractRecord(record: RuntimeContractRecord, body?: string): string {
  const frontmatter = stringify(record).trimEnd();
  const heading = typeof record.name === "string" && record.name.length > 0 ? record.name : record.id;
  const recordBody = body ?? `# ${heading}\n\nMaterialized runtime contract for \`${record.id}\`.\n`;
  return `---\n${frontmatter}\n---\n\n${recordBody}`;
}

export function validateRuntimeContractRecord(record: RuntimeContractRecord, path: string): RuntimeDiagnostic[] {
  const validator = getValidator(record.type);
  if (!validator) return [];
  const diagnostics = runValidator(validator, record, path);
  const schemas = record.schemas;
  if (record.type === "action" && isPlainObject(schemas)) {
    diagnostics.push(...validateEmbeddedJsonSchema(schemas.input, `${path}#/schemas/input`));
    if (schemas.output != null) {
      diagnostics.push(...validateEmbeddedJsonSchema(schemas.output, `${path}#/schemas/output`));
    }
  }
  if (record.type === "event" && isPlainObject(schemas)) {
    diagnostics.push(...validateEmbeddedJsonSchema(schemas.payload, `${path}#/schemas/payload`));
  }
  return diagnostics;
}

function addRuntimeRecordToRegistry(
  registry: RuntimeRegistry,
  record: RuntimeMarkdownRecord<RuntimeContractRecord>,
): void {
  const contract = record.frontmatter;
  const target = registryMapFor(registry, contract.type);
  if (!target) return;

  const existing = target.get(contract.id);
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(contract)) return;
    registry.diagnostics.push({
      severity: "error",
      code: "contract_conflict",
      message: `Conflicting ${contract.type} contract ${contract.id}.`,
      path: record.path,
      id: contract.id,
      details: {
        existingVersion: existing.version,
        newVersion: contract.version,
      },
    });
    return;
  }

  target.set(contract.id, contract as never);
  if (contract.type === "provider") {
    registry.providers.add(contract.id);
    for (const capability of (contract as RuntimeProviderContract).contracts?.capabilities ?? []) {
      registry.capabilityIds.add(capability);
    }
  }
  if (contract.type === "capability") registry.capabilityIds.add(contract.id);
  if (contract.type === "action") {
    const action = contract as RuntimeActionContract;
    for (const capability of [...(action.requires?.capabilities ?? []), ...(action.effects ?? [])]) {
      registry.capabilityIds.add(capability);
    }
  }
  if (typeof contract.provider === "string" && contract.provider.length > 0) {
    registry.providers.add(contract.provider);
  }
}

function registryMapFor(
  registry: RuntimeRegistry,
  type: RuntimeRecordType,
): Map<string, RuntimeContractRecord> | undefined {
  switch (type) {
    case "provider":
      return registry.providerContracts as Map<string, RuntimeContractRecord>;
    case "action":
      return registry.actions as Map<string, RuntimeContractRecord>;
    case "event":
      return registry.events as Map<string, RuntimeContractRecord>;
    case "capability":
      return registry.capabilities as Map<string, RuntimeContractRecord>;
    case "workflow":
      return registry.workflows as Map<string, RuntimeContractRecord>;
    case "runtime_policy":
      return registry.policies as Map<string, RuntimeContractRecord>;
    default:
      return undefined;
  }
}

function getAjv(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  return ajv;
}

function getValidator(name: RuntimeRecordType | "eventEnvelope"): ValidateFunction | undefined {
  if (!validators) {
    const instance = getAjv();
    const schemas = getCanonicalSchemas();
    validators = {
      provider: instance.compile(schemas.provider),
      action: instance.compile(schemas.action),
      event: instance.compile(schemas.event),
      capability: instance.compile(schemas.capability),
      workflow: instance.compile(schemas.workflow),
      runtime_policy: instance.compile(schemas.runtimePolicy),
      runtime_run: instance.compile(schemas.run),
      runtime_checkpoint: instance.compile(schemas.checkpoint),
      runtime_diagnostic: instance.compile(schemas.diagnostic),
      eventEnvelope: instance.compile(schemas.eventEnvelope),
    };
  }
  return validators[name];
}

function runValidator(validate: ValidateFunction, value: unknown, path: string): RuntimeDiagnostic[] {
  const valid = validate(value);
  if (valid) return [];
  return (validate.errors ?? []).map((error) => toDiagnostic(error, path));
}

function toDiagnostic(error: ErrorObject, path: string): RuntimeDiagnostic {
  const params = error.params as Record<string, unknown>;
  const missingProperty = typeof params.missingProperty === "string" ? params.missingProperty : undefined;
  const additionalProperty = typeof params.additionalProperty === "string" ? params.additionalProperty : undefined;
  return {
    severity: "error",
    code: `schema_${snakeCaseKeyword(error.keyword)}`,
    message: error.message ?? `Schema validation failed at ${error.instancePath || "/"}.`,
    path,
    field: jsonPointerToFieldPath(error.instancePath) ?? missingProperty ?? additionalProperty,
    details: error.params,
  };
}

function snakeCaseKeyword(keyword: string): string {
  return keyword.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function validateEmbeddedJsonSchema(schema: unknown, path: string): RuntimeDiagnostic[] {
  if (!isPlainObject(schema)) return [];
  const instance = getAjv();
  if (instance.validateSchema(schema)) return [];
  return schemaDiagnostics(instance.errors, path, "invalid_embedded_schema");
}

function schemaDiagnostics(
  errors: ErrorObject[] | null | undefined,
  path: string,
  code: string,
): RuntimeDiagnostic[] {
  return (errors ?? []).map((error) => ({
    severity: "error" as const,
    code,
    message: error.message ?? "Embedded JSON Schema is invalid.",
    path,
    field: jsonPointerToFieldPath(error.instancePath),
    details: error.params,
  }));
}

function resolveRequires(
  registry: RuntimeRegistry,
  requiresValue: RuntimeRequires | undefined,
  source: string,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const capability of requiresValue?.capabilities ?? []) {
    if (!registry.capabilityIds.has(capability)) {
      diagnostics.push(unresolved("unresolved_capability", capability, source));
    }
  }
  for (const requirement of requiresValue?.providers ?? []) {
    const providerId = typeof requirement === "string" ? requirement : requirement.id;
    if (!registry.providers.has(providerId)) {
      diagnostics.push(unresolved("unresolved_provider", providerId, source));
      continue;
    }
    if (typeof requirement !== "string") {
      const provider = registry.providerContracts.get(providerId);
      if (!provider || !satisfies(provider.provider_version, requirement.version, { includePrerelease: true })) {
        diagnostics.push({
          severity: "error",
          code: "provider_version_mismatch",
          message: `Provider ${providerId} does not satisfy ${requirement.version}.`,
          id: providerId,
          details: { required: requirement.version, actual: provider?.provider_version },
        });
      }
    }
  }
  return diagnostics;
}

function duplicatesById(values: Array<{ id?: string }>, code: string, source: string): RuntimeDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const value of values) {
    if (typeof value.id !== "string") continue;
    if (seen.has(value.id)) {
      diagnostics.push({
        severity: "error",
        code,
        message: `${value.id} is duplicated in workflow ${source}.`,
        id: value.id,
      });
      continue;
    }
    seen.add(value.id);
  }
  return diagnostics;
}

function unresolved(code: string, id: string, source?: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code,
    message: `${id} could not be resolved${source ? ` from ${source}` : ""}.`,
    id,
  };
}

function result(diagnostics: RuntimeDiagnostic[]): RuntimeValidationResult {
  return {
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonPointerToFieldPath(pointer: string): string | undefined {
  if (!pointer) return undefined;
  return pointer
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function selectedPolicy(registry: RuntimeRegistry): RuntimePolicyContract | undefined {
  if (!registry.selectedPolicyId) return undefined;
  const policy = registry.policies.get(registry.selectedPolicyId);
  return policy?.enabled === false ? undefined : policy;
}

function selectedExecutor(registry: RuntimeRegistry, workflowId: string): string | undefined {
  const policy = selectedPolicy(registry);
  return policy?.executors?.workflows?.[workflowId] ?? policy?.executors?.default;
}

function collectRequiredCapabilities(
  registry: RuntimeRegistry,
  workflow: RuntimeWorkflowContract,
): Set<string> {
  const capabilities = new Set(workflow.requires?.capabilities ?? []);
  for (const step of workflow.steps ?? []) {
    for (const capability of step.requires?.capabilities ?? []) capabilities.add(capability);
    const action = registry.actions.get(step.action);
    for (const capability of action?.requires?.capabilities ?? []) capabilities.add(capability);
    for (const capability of action?.effects ?? []) capabilities.add(capability);
  }
  return capabilities;
}

function validateProviderListings(registry: RuntimeRegistry): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const mappings: Array<[keyof NonNullable<RuntimeProviderContract["contracts"]>, Map<string, unknown> | Set<string>, string]> = [
    ["events", registry.events, "unresolved_provider_event"],
    ["actions", registry.actions, "unresolved_provider_action"],
    ["capabilities", registry.capabilityIds, "unresolved_provider_capability"],
    ["workflows", registry.workflows, "unresolved_provider_workflow"],
  ];
  for (const provider of registry.providerContracts.values()) {
    for (const [kind, target, code] of mappings) {
      for (const id of provider.contracts?.[kind] ?? []) {
        if (!target.has(id)) diagnostics.push(unresolved(code, id, provider.id));
      }
    }
  }
  return diagnostics;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
