import { describe, it, expect } from "bun:test";
import { findActualString, normalizeIndentation } from "./utils";

describe("findActualString", () => {
  it("exact match works", () => {
    const file = "  foo\n  bar";
    expect(findActualString(file, "  bar")).toBe("  bar");
  });

  it("tab in file, spaces in search => matches via indent normalization", () => {
    const file = "\t\tfoo\n\t\tbar";
    const result = findActualString(file, "    bar"); // model sent spaced ver
    expect(result).toBe("\t\tbar");
  });

  it("spaces in file, tabs in search => matches via indent normalization", () => {
    const file = "    bar"; // 4-space indented file
    const result = findActualString(file, "\tbar"); // model sent tab version
    expect(result).toBe("    bar"); // should return actual content from file
  });

  it("normalizeIndentation trims leading whitespace", () => {
    expect(normalizeIndentation("  hello")).toBe("hello");
    expect(normalizeIndentation("\t\tfoo\n\t\tbar")).toBe("foo\nbar");
  });

  it("indent normalization preserves original string content", () => {
    const file = "function test() {\n\tif (true) {\n\t\tconsole.log('hello');\n\t}\n}";
    const search = "function test() {\n  if (true) {\n    console.log('hello');\n  }\n}";
    const result = findActualString(file, search);
    expect(result).toBe(file);
  });

  it("exact match preferred over indent normalization when both possible", () => {
    // File has tab-indented line
    const file = "\t\tfoo\n\t\tbar";
    const search = "\t\tbar"; // exact match - tab

    // exact match should win (check via includes returning true first)
    expect(findActualString(file, search)).toBe("\t\tbar");
  });
});