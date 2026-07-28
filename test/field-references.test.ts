import { describe, expect, it } from "vitest";
import {
  fieldReferenceTargetsTopLevel,
  getFieldReferenceValue,
  getFieldReferenceValues,
  isValidFieldReference,
  schemaDeclaresFieldReference,
  setFieldReferenceValue,
} from "../src/field-references.js";

describe("v0.3 field references", () => {
  it("accepts legacy field paths and non-root RFC 6901 JSON Pointers", () => {
    expect(isValidFieldReference("metadata.owner")).toBe(true);
    expect(isValidFieldReference("relations[]")).toBe(true);
    expect(isValidFieldReference("/@type")).toBe(true);
    expect(isValidFieldReference("/a~1b")).toBe(true);
    expect(isValidFieldReference("")).toBe(false);
    expect(isValidFieldReference("#/@type")).toBe(false);
    expect(isValidFieldReference("/bad~escape")).toBe(false);
  });

  it("resolves exact and escaped JSON object keys without changing legacy arrays", () => {
    const value = {
      "@type": "Contact",
      "literal.dot": "dot",
      "a/b": "slash",
      "a~b": "tilde",
      relations: [{ id: 1 }, { id: 2 }],
    };
    expect(getFieldReferenceValue(value, "/@type")).toEqual({ present: true, value: "Contact" });
    expect(getFieldReferenceValue(value, "/literal.dot")).toEqual({ present: true, value: "dot" });
    expect(getFieldReferenceValue(value, "/a~1b")).toEqual({ present: true, value: "slash" });
    expect(getFieldReferenceValue(value, "/a~0b")).toEqual({ present: true, value: "tilde" });
    expect(getFieldReferenceValue(value, "/relations/1/id")).toEqual({ present: true, value: 2 });
    expect(getFieldReferenceValues(value, "relations[].id")).toEqual([1, 2]);
    expect(getFieldReferenceValues(value, "/relations")).toEqual([[{ id: 1 }, { id: 2 }]]);
  });

  it("writes exact property names and refuses to traverse scalar values", () => {
    const value: Record<string, unknown> = { metadata: { label: "Ada" }, scalar: "fixed" };
    setFieldReferenceValue(value, "/@type", "Contact");
    setFieldReferenceValue(value, "/metadata/a~1b", "slash");
    expect(value).toEqual({
      "@type": "Contact",
      metadata: { label: "Ada", "a/b": "slash" },
      scalar: "fixed",
    });
    expect(() => setFieldReferenceValue(value, "/scalar/nested", true)).toThrow("non-container");
  });

  it("uses decoded references for schema declarations and required fields", () => {
    const schema = {
      type: "object",
      properties: {
        "@type": { const: "Contact" },
        "a/b": { type: "string" },
        nested: {
          type: "object",
          properties: { label: { type: "string" } },
        },
      },
    };
    expect(schemaDeclaresFieldReference(schema, "/@type")).toBe(true);
    expect(schemaDeclaresFieldReference(schema, "/a~1b")).toBe(true);
    expect(schemaDeclaresFieldReference(schema, "nested.label")).toBe(true);
    expect(fieldReferenceTargetsTopLevel("/@type", "@type")).toBe(true);
    expect(fieldReferenceTargetsTopLevel("/nested/label", "nested")).toBe(false);
  });
});
