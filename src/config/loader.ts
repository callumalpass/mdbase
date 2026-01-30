/**
 * Configuration loader for mdbase.yaml files.
 * Implements §4 of the mdbase specification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

export interface MdbaseSettings {
  extensions: string[];
  exclude: string[];
  include_subfolders: boolean;
  types_folder: string;
  explicit_type_keys: string[];
  default_validation: "off" | "warn" | "error";
  default_strict: boolean | "warn";
  id_field: string;
  write_nulls: "omit" | "explicit";
  write_empty_lists: boolean;
  rename_update_refs: boolean;
  cache_folder: string;
}

export interface MdbaseConfig {
  spec_version: string;
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

const DEFAULT_SETTINGS: MdbaseSettings = {
  extensions: [],
  exclude: [".git", "node_modules", ".mdbase"],
  include_subfolders: true,
  types_folder: "_types",
  explicit_type_keys: ["type", "types"],
  default_validation: "warn",
  default_strict: false,
  id_field: "id",
  write_nulls: "omit",
  write_empty_lists: true,
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
  "extensions",
  "exclude",
  "include_subfolders",
  "types_folder",
  "explicit_type_keys",
  "default_validation",
  "default_strict",
  "id_field",
  "write_nulls",
  "write_empty_lists",
  "rename_update_refs",
  "cache_folder",
]);

/**
 * Load and validate an mdbase.yaml configuration file.
 */
export function loadConfig(collectionRoot: string): ConfigLoadResult {
  const configPath = path.join(collectionRoot, "mdbase.yaml");
  const warnings: string[] = [];

  // Check file exists
  if (!fs.existsSync(configPath)) {
    return {
      valid: false,
      error: { code: "missing_config", message: "mdbase.yaml not found" },
    };
  }

  // Read and parse YAML
  let raw: unknown;
  try {
    const content = fs.readFileSync(configPath, "utf-8");
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
      warnings.push(`Unknown top-level key: ${key}`);
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

  // Handle "0.1" alias for "0.1.0"
  const shortVersionMatch = specVersion.match(/^(\d+)\.(\d+)$/);
  if (shortVersionMatch) {
    warnings.push(
      `spec_version "${specVersion}" is a shorthand; normalizing to "${specVersion}.0"`,
    );
    specVersion = `${specVersion}.0`;
  }

  // Parse semver
  const versionMatch = specVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
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

  // Major version must be 0 (we only support 0.x)
  if (major !== 0) {
    return {
      valid: false,
      error: {
        code: "unsupported_version",
        message: `Unsupported major version: ${major}`,
      },
    };
  }

  // During 0.x, minor must match (we support 0.1.x)
  if (minor !== 1) {
    return {
      valid: false,
      error: {
        code: "unsupported_version",
        message: `Unsupported minor version: 0.${minor}`,
      },
    };
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
    settings: settingsResult.settings!,
  };

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

  // extensions
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
      // Normalize leading dot
      const hadDot = e.startsWith(".");
      if (hadDot) {
        e = e.slice(1);
      }
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

  // default_validation
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

  return { valid: true, settings };
}
