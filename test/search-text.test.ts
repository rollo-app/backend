import { describe, expect, it } from "vitest";
import { nameSearchColumn, normalizeSearchQuery, searchText } from "../src/lib/search-text";

describe("searchText", () => {
  it("lowercases, strips accents and collapses whitespace", () => {
    expect(searchText("  Martín   Gómez ")).toBe("martin gomez");
    expect(searchText("ÑANDÚ")).toBe("nandu");
  });
});

describe("normalizeSearchQuery", () => {
  it("drops every leading @ and normalizes", () => {
    expect(normalizeSearchQuery("@Cami.P")).toBe("cami.p");
    expect(normalizeSearchQuery(" @ ")).toBe("");
    expect(normalizeSearchQuery("@@cami")).toBe("cami");
  });
});

describe("nameSearchColumn", () => {
  it("prefixes a space for word-prefix matching", () => {
    expect(nameSearchColumn("Ana Camila")).toBe(" ana camila");
  });
  it("is null for blank or null names", () => {
    expect(nameSearchColumn("   ")).toBeNull();
    expect(nameSearchColumn(null)).toBeNull();
  });
});
