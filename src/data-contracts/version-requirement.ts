/**
 * Portable contract version requirements (spec Chapter 05A, "Version
 * Requirements"): an exact version, `^` and `~` ranges, and space-separated
 * comparator sets. Pre-release versions satisfy a requirement whenever they
 * fall inside its bounds, and build metadata is ignored.
 */
import semver from "semver";

const VERSION = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const COMPARATOR = String.raw`(?:>=|<=|>|<|=)${VERSION}`;
const PORTABLE_REQUIREMENT = new RegExp(String.raw`^(?:[\^~=]?${VERSION}|${COMPARATOR}(?: ${COMPARATOR})*)$`);

// npm `semver` gives `^` and `~` an exclusive `-0` upper bound when
// pre-releases are included, which is exactly the portable definition.
const OPTIONS = { includePrerelease: true } as const;

export function isPortableVersionRequirement(requirement: string): boolean {
  return PORTABLE_REQUIREMENT.test(requirement);
}

/** The highest candidate version that satisfies `requirement`, or null. */
export function resolveVersionRequirement(requirement: string, candidates: Iterable<string>): string | null {
  if (!isPortableVersionRequirement(requirement)) {
    throw new Error(`'${requirement}' is not a portable version requirement`);
  }
  return semver.maxSatisfying([...candidates].filter((candidate) => semver.valid(candidate)), requirement, OPTIONS);
}
