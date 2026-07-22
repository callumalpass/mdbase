import { evaluateExpression } from "../expressions/evaluator.js";

export function computeLegacyQuerySummaries(
  rows: Array<{ frontmatter: Record<string, unknown> }>,
  propertySummaries: Record<string, string>,
  customSummaries: Record<string, string>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [field, summaryType] of Object.entries(propertySummaries)) {
    const values = rows.map((row) => row.frontmatter[field]).filter((value) => value !== undefined);

    if (customSummaries[summaryType]) {
      summary[field] = evaluateCustomSummary(customSummaries[summaryType], values);
      continue;
    }

    switch (summaryType) {
      case "Average":
        summary[field] = average(values);
        break;
      case "Sum":
        summary[field] = numbers(values).reduce((left, right) => left + right, 0);
        break;
      case "Min":
        summary[field] = minimum(values);
        break;
      case "Max":
        summary[field] = maximum(values);
        break;
      case "Earliest":
        summary[field] = sortedStrings(values).at(0) ?? null;
        break;
      case "Latest":
        summary[field] = sortedStrings(values).at(-1) ?? null;
        break;
      case "Checked":
        summary[field] = values.filter((value) => value === true).length;
        break;
      case "Unchecked":
        summary[field] = values.filter((value) => value === false).length;
        break;
      case "Empty":
        summary[field] = rows.filter((row) => isEmpty(row.frontmatter[field])).length;
        break;
      case "Filled":
        summary[field] = rows.filter((row) => !isEmpty(row.frontmatter[field])).length;
        break;
      case "Unique":
        summary[field] = new Set(values.map((value) => JSON.stringify(value))).size;
        break;
      default:
        summary[field] = null;
    }
  }
  return summary;
}

export function detectCircularFormulas(
  formulas: Record<string, string>,
): { code: string; message: string } | null {
  const formulaNames = new Set(Object.keys(formulas));
  const dependencies = new Map<string, Set<string>>();

  for (const [name, expression] of Object.entries(formulas)) {
    const fieldDependencies = new Set<string>();
    for (const match of expression.matchAll(/formula\.(\w+)/g)) {
      const reference = match[1];
      if (reference === name) {
        return { code: "circular_formula", message: `Self-referencing formula: "${name}"` };
      }
      if (formulaNames.has(reference)) fieldDependencies.add(reference);
    }
    dependencies.set(name, fieldDependencies);
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const hasCycle = (name: string): boolean => {
    if (active.has(name)) return true;
    if (visited.has(name)) return false;
    visited.add(name);
    active.add(name);
    for (const dependency of dependencies.get(name) ?? []) {
      if (hasCycle(dependency)) return true;
    }
    active.delete(name);
    return false;
  };

  for (const name of formulaNames) {
    if (hasCycle(name)) {
      return { code: "circular_formula", message: `Circular reference in formulas involving "${name}"` };
    }
  }
  return null;
}

function evaluateCustomSummary(formula: string, values: unknown[]): unknown {
  try {
    return evaluateExpression(formula, { frontmatter: { values } });
  } catch {
    return null;
  }
}

function numbers(values: unknown[]): number[] {
  return values.filter((value): value is number => typeof value === "number");
}

function average(values: unknown[]): number | null {
  const selected = numbers(values);
  return selected.length > 0
    ? selected.reduce((left, right) => left + right, 0) / selected.length
    : null;
}

function minimum(values: unknown[]): number | null {
  const selected = numbers(values);
  return selected.length > 0 ? Math.min(...selected) : null;
}

function maximum(values: unknown[]): number | null {
  const selected = numbers(values);
  return selected.length > 0 ? Math.max(...selected) : null;
}

function sortedStrings(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string").sort();
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
