/**
 * Configuration loader for mdbase.yaml files.
 * Implements §4 of the mdbase specification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

export interface MdbaseSettings {
  timezone?: string;
  record_extensions: string[];
  extensions: string[];
  exclude: string[];
  include_subfolders: boolean;
  types_folder: string;
  contracts_folder: string;
  migrations_folder: string;
  explicit_type_keys: string[];
  default_validation: "off" | "warn" | "error";
  default_strict: boolean | "warn";
  id_field: string;
  id_field_explicit?: boolean;
  write_nulls: "omit" | "explicit";
  write_empty_lists: boolean;
  write_defaults: boolean;
  rename_update_refs: boolean;
  cache_folder: string;
}

export interface MdbaseConfig {
  spec_version: string;
  spec_profile: "v0.2" | "v0.3";
  name?: string;
  description?: string;
  settings: MdbaseSettings;
}

export interface ConfigLoadResult {
  valid: boolean;
  config?: MdbaseConfig;
  warnings?: string[];
  error?: { code: string; message: string };
}

export const SUPPORTED_SPEC_VERSION = "0.3.0";
export const PRERELEASE_SPEC_VERSIONS = ["0.3.0-alpha.1"] as const;
export const LEGACY_SPEC_VERSION = "0.2.1";

export function isSupportedV03SpecVersion(version: string): boolean {
  return version === SUPPORTED_SPEC_VERSION
    || PRERELEASE_SPEC_VERSIONS.includes(version as typeof PRERELEASE_SPEC_VERSIONS[number]);
}

const DEFAULT_SETTINGS: MdbaseSettings = {
  record_extensions: ["md"],
  extensions: [],
  exclude: [".git", "node_modules", ".mdbase"],
  include_subfolders: true,
  types_folder: "_types",
  contracts_folder: "_contracts",
  migrations_folder: "_types/_migrations",
  explicit_type_keys: ["type", "types"],
  default_validation: "warn",
  default_strict: false,
  id_field: "id",
  write_nulls: "omit",
  write_empty_lists: true,
  write_defaults: true,
  rename_update_refs: true,
  cache_folder: ".mdbase",
};

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "spec_version",
  "name",
  "description",
  "settings",
]);

const KNOWN_SETTINGS_KEYS = new Set([
  "timezone",
  "record_extensions",
  "extensions",
  "exclude",
  "include_subfolders",
  "types_folder",
  "contracts_folder",
  "migrations_folder",
  "explicit_type_keys",
  "default_validation",
  "default_strict",
  "id_field",
  "write_nulls",
  "write_empty_lists",
  "write_defaults",
  "rename_update_refs",
  "cache_folder",
  "validation",
]);

export async function loadConfigAsync(
  collectionRoot: string,
  options?: { allowFutureMinor?: boolean },
): Promise<ConfigLoadResult> {
  const configPath = path.join(collectionRoot, "mdbase.yaml");
  const warnings: string[] = [];

  // Check file exists
  try {
    await fs.promises.access(configPath);
  } catch {
    return {
      valid: false,
      error: { code: "missing_config", message: "mdbase.yaml not found" },
    };
  }

  // Read and parse YAML
  let raw: unknown;
  try {
    const content = await fs.promises.readFile(configPath, "utf-8");
    raw = yaml.load(content);
  } catch {
    return {
      valid: false,
      error: {
        code: "invalid_config",
        message: "Failed to parse mdbase.yaml as YAML",
      },
    };
  }

  // Must be a mapping (object), not a list or scalar
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      error: {
        code: "invalid_config",
        message: "mdbase.yaml must be a YAML mapping",
      },
    };
  }

  const rawConfig = raw as Record<string, unknown>;

  // Check for unknown top-level keys
  for (const key of Object.keys(rawConfig)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(
        key === "runtime"
          ? "The mdbase runtime 0.1 config section is superseded. Runtime 0.2 host enablement and policy selection belong in host settings; install the standard runtime pack for portable records."
          : `Unknown top-level key: ${key}`,
      );
    }
  }

  // Validate spec_version
  if (!("spec_version" in rawConfig) || rawConfig.spec_version === undefined || rawConfig.spec_version === null) {
    return {
      valid: false,
      error: {
        code: "invalid_config",
        message: "spec_version is required",
      },
    };
  }

  let specVersion = String(rawConfig.spec_version);

  // Preserve the v0.2 compatibility adapter's historical shorthand.
  const shortVersionMatch = specVersion.match(/^(\d+)\.(\d+)$/);
  if (shortVersionMatch) {
    const shortMajor = parseInt(shortVersionMatch[1], 10);
    const shortMinor = parseInt(shortVersionMatch[2], 10);
    const normalizedPatch = shortMajor === 0 && shortMinor === 2 ? 1 : 0;
    const normalizedVersion = `${shortMajor}.${shortMinor}.${normalizedPatch}`;
    warnings.push(
      `spec_version "${specVersion}" is a shorthand; normalizing to "${normalizedVersion}"`,
    );
    specVersion = normalizedVersion;
  }

  // Parse SemVer, including retained v0.3 prerelease identifiers.
  const versionMatch = specVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/);
  if (!versionMatch) {
    return {
      valid: false,
      error: {
        code: "unsupported_version",
        message: `Invalid spec_version format: ${specVersion}`,
      },
    };
  }

  const major = parseInt(versionMatch[1], 10);
  const minor = parseInt(versionMatch[2], 10);
  if (major !== 0) {
    return {
      valid: false,
      error: {
        code: "unsupported_version",
        message: `Unsupported major version: ${major}`,
      },
    };
  }

  const isV03 = isSupportedV03SpecVersion(specVersion);
  const isLegacyV02 = minor === 2 && versionMatch[4] === undefined;
  if (!isV03 && !isLegacyV02) {
    if (options?.allowFutureMinor && minor > 3) {
      warnings.push(
        `spec_version "${specVersion}" is newer than supported v0.3; attempting with the v0.3 profile`,
      );
    } else {
      return {
        valid: false,
        error: {
          code: "unsupported_version",
          message: `Unsupported spec version: ${specVersion} (supported: ${SUPPORTED_SPEC_VERSION}; legacy adapter: 0.2.x)`,
        },
      };
    }
  }

  if (isV03 && specVersion !== SUPPORTED_SPEC_VERSION) {
    warnings.push(
      `spec_version "${specVersion}" is a compatible v0.3 prerelease; new collections use "${SUPPORTED_SPEC_VERSION}"`,
    );
  }

  // Parse settings
  const rawSettings = rawConfig.settings as Record<string, unknown> | undefined;
  const settingsResult = parseSettings(rawSettings, warnings);
  if (!settingsResult.valid) {
    return {
      valid: false,
      error: settingsResult.error,
    };
  }

  const config: MdbaseConfig = {
    spec_version: specVersion,
    spec_profile: isLegacyV02 ? "v0.2" : "v0.3",
    settings: settingsResult.settings!,
  };

  // Support top-level id_field shorthand
  if (rawConfig.id_field !== undefined && !(rawSettings && rawSettings.id_field !== undefined)) {
    config.settings.id_field = String(rawConfig.id_field);
    config.settings.id_field_explicit = true;
  }

  // Support top-level default_validation shorthand
  if (rawConfig.default_validation !== undefined && !(rawSettings && rawSettings.default_validation !== undefined)) {
    const val = String(rawConfig.default_validation);
    if (["off", "warn", "error"].includes(val)) {
      config.settings.default_validation = val as "off" | "warn" | "error";
    }
  }

  if (rawConfig.name !== undefined) {
    config.name = String(rawConfig.name);
  }
  if (rawConfig.description !== undefined) {
    config.description = String(rawConfig.description);
  }
  return {
    valid: true,
    config,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export const loadConfig = loadConfigAsync;

interface SettingsParseResult {
  valid: boolean;
  settings?: MdbaseSettings;
  error?: { code: string; message: string };
}

function parseSettings(
  raw: Record<string, unknown> | undefined,
  warnings: string[],
): SettingsParseResult {
  const settings: MdbaseSettings = { ...DEFAULT_SETTINGS };
  let migrationsFolderExplicit = false;

  if (!raw) {
    return { valid: true, settings };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      error: {
        code: "invalid_config",
        message: "settings must be a mapping",
      },
    };
  }

  // Check for unknown settings keys
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SETTINGS_KEYS.has(key)) {
      warnings.push(`Unknown settings key: ${key}`);
    }
  }

  // record_extensions (v0.3 name): complete record extension set.
  if (raw.record_extensions !== undefined) {
    if (!Array.isArray(raw.record_extensions)) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.record_extensions must be a list",
        },
      };
    }
    const normalized = normalizeExtensions(raw.record_extensions);
    settings.record_extensions = normalized.length > 0 ? normalized : ["md"];
    settings.extensions = settings.record_extensions.filter((ext) => ext !== "md");
  }

  // extensions (v0.2 name): additional extensions; .md is always included.
  if (raw.extensions !== undefined) {
    if (!Array.isArray(raw.extensions)) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.extensions must be a list",
        },
      };
    }
    const normalized: string[] = [];
    for (const ext of raw.extensions) {
      let e = String(ext);
      const hadDot = e.startsWith(".");
      if (hadDot) e = e.slice(1);
      // Warn about md being in the list
      if (e === "md") {
        warnings.push(
          `"${hadDot ? "." : ""}md" in extensions list is unnecessary (.md is always included)`,
        );
        continue;
      }
      normalized.push(e);
    }
    settings.extensions = normalized;
    settings.record_extensions = ["md", ...normalized];
  }

  // exclude
  if (raw.exclude !== undefined) {
    if (!Array.isArray(raw.exclude)) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.exclude must be a list",
        },
      };
    }
    settings.exclude = raw.exclude.map(String);
  }

  // include_subfolders
  if (raw.include_subfolders !== undefined) {
    if (typeof raw.include_subfolders !== "boolean") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.include_subfolders must be a boolean",
        },
      };
    }
    settings.include_subfolders = raw.include_subfolders;
  }

  // types_folder
  if (raw.types_folder !== undefined) {
    if (typeof raw.types_folder !== "string") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.types_folder must be a string",
        },
      };
    }
    settings.types_folder = raw.types_folder;
  }

  // contracts_folder
  if (raw.contracts_folder !== undefined) {
    if (typeof raw.contracts_folder !== "string") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.contracts_folder must be a string",
        },
      };
    }
    settings.contracts_folder = raw.contracts_folder;
  }

  const invalidTypesFolder = validateControlFolder(settings.types_folder);
  if (invalidTypesFolder) {
    return {
      valid: false,
      error: { code: "invalid_config", message: `settings.types_folder ${invalidTypesFolder}` },
    };
  }
  const invalidContractsFolder = validateControlFolder(settings.contracts_folder);
  if (invalidContractsFolder) {
    return {
      valid: false,
      error: { code: "invalid_config", message: `settings.contracts_folder ${invalidContractsFolder}` },
    };
  }
  if (normalizeControlFolder(settings.contracts_folder) === normalizeControlFolder(settings.types_folder)) {
    return {
      valid: false,
      error: {
        code: "invalid_config",
        message: "settings.contracts_folder must differ from settings.types_folder",
      },
    };
  }

  // migrations_folder
  if (raw.migrations_folder !== undefined) {
    if (typeof raw.migrations_folder !== "string") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.migrations_folder must be a string",
        },
      };
    }
    settings.migrations_folder = raw.migrations_folder;
    migrationsFolderExplicit = true;
  }

  // If types_folder changed and migrations_folder wasn't explicit, derive default from types_folder
  if (!migrationsFolderExplicit && raw?.types_folder !== undefined) {
    settings.migrations_folder = `${settings.types_folder}/_migrations`;
  }

  // explicit_type_keys
  if (raw.explicit_type_keys !== undefined) {
    if (!Array.isArray(raw.explicit_type_keys)) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.explicit_type_keys must be a list",
        },
      };
    }
    settings.explicit_type_keys = raw.explicit_type_keys.map(String);
  }

  // default_validation (v0.2 name)
  if (raw.default_validation !== undefined) {
    const val = String(raw.default_validation);
    if (!["off", "warn", "error"].includes(val)) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: `settings.default_validation must be "off", "warn", or "error", got "${val}"`,
        },
      };
    }
    settings.default_validation = val as "off" | "warn" | "error";
  }

  // validation (v0.3 name)
  if (raw.validation !== undefined && raw.default_validation === undefined) {
    const val = String(raw.validation);
    if (!["off", "warn", "error"].includes(val)) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: `settings.validation must be "off", "warn", or "error", got "${val}"`,
        },
      };
    }
    settings.default_validation = val as "off" | "warn" | "error";
  }

  // default_strict
  if (raw.default_strict !== undefined) {
    const val = raw.default_strict;
    if (val !== true && val !== false && val !== "warn") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: `settings.default_strict must be true, false, or "warn"`,
        },
      };
    }
    settings.default_strict = val as boolean | "warn";
  }

  // id_field
  if (raw.id_field !== undefined) {
    if (typeof raw.id_field !== "string") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.id_field must be a string",
        },
      };
    }
    settings.id_field = raw.id_field;
    settings.id_field_explicit = true;
  }

  // write_nulls
  if (raw.write_nulls !== undefined) {
    const val = String(raw.write_nulls);
    if (!["omit", "explicit"].includes(val)) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: `settings.write_nulls must be "omit" or "explicit", got "${val}"`,
        },
      };
    }
    settings.write_nulls = val as "omit" | "explicit";
  }

  // write_empty_lists
  if (raw.write_empty_lists !== undefined) {
    if (typeof raw.write_empty_lists !== "boolean") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.write_empty_lists must be a boolean",
        },
      };
    }
    settings.write_empty_lists = raw.write_empty_lists;
  }

  // write_defaults
  if (raw.write_defaults !== undefined) {
    if (typeof raw.write_defaults !== "boolean") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.write_defaults must be a boolean",
        },
      };
    }
    settings.write_defaults = raw.write_defaults;
  }

  // rename_update_refs
  if (raw.rename_update_refs !== undefined) {
    if (typeof raw.rename_update_refs !== "boolean") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.rename_update_refs must be a boolean",
        },
      };
    }
    settings.rename_update_refs = raw.rename_update_refs;
  }

  // cache_folder
  if (raw.cache_folder !== undefined) {
    if (typeof raw.cache_folder !== "string") {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.cache_folder must be a string",
        },
      };
    }
    settings.cache_folder = raw.cache_folder;
  }

  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== "string" || !raw.timezone.trim()) {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: "settings.timezone must be a non-empty string",
        },
      };
    }
    const timezone = raw.timezone.trim();
    try {
      if (
        timezone.toLowerCase() === "local" ||
        /^[+-]\d{2}:\d{2}$/.test(timezone)
      ) throw new RangeError();
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    } catch {
      return {
        valid: false,
        error: {
          code: "invalid_config",
          message: `Unknown IANA timezone "${timezone}"`,
        },
      };
    }
    settings.timezone = timezone;
  }

  return { valid: true, settings };
}

function normalizeExtensions(values: unknown[]): string[] {
  const extensions: string[] = [];
  for (const value of values) {
    const ext = String(value).replace(/^\./, "");
    if (ext && !extensions.includes(ext)) {
      extensions.push(ext);
    }
  }
  return extensions;
}

function validateControlFolder(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return "must be a non-empty relative path without traversal segments";
  }
  return undefined;
}

function normalizeControlFolder(value: string): string {
  return value.replaceAll("\\", "/");
}
