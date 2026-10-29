import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PageQuerySchema, paginate, resolveSort } from "../src/lib/paging";

const created = sql`created_at`;
const name = sql`name`;

const spec = (rows: unknown[] = [], total = 0) => {
  const calls: any[] = [];
  return {
    calls,
    spec: {
      rows: async (o: any) => (calls.push(o), rows),
      count: async () => total,
      sortable: { createdAt: created, name },
      defaultSort: "createdAt",
    },
  };
};

describe("PageQuerySchema", () => {
  it("applies defaults and coerces numbers", () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25, order: "desc" });
    expect(PageQuerySchema.parse({ page: "3", pageSize: "50", q: "  ana " })).toMatchObject({ page: 3, pageSize: 50, q: "ana" });
  });
  it("rejects page 0, pageSize 101 and a 101-char q", () => {
    expect(PageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });
});

describe("resolveSort", () => {
  it("uses defaultSort desc, honors sort+order, rejects unknown sort", () => {
    const { spec: s } = spec();
    expect(resolveSort(s, PageQuerySchema.parse({}))).toEqual({ column: created, order: "desc", key: "createdAt" });
    expect(resolveSort(s, PageQuerySchema.parse({ sort: "name", order: "asc" }))).toEqual({ column: name, order: "asc", key: "name" });
    expect(() => resolveSort(s, PageQuerySchema.parse({ sort: "email" }))).toThrowError(expect.objectContaining({ kind: "bad_request" }));
  });
});

describe("paginate", () => {
  it("computes offset/limit and returns the page shape", async () => {
    const { spec: s, calls } = spec([{ id: 1 }], 57);
    const page = await paginate(s, PageQuerySchema.parse({ page: 3, pageSize: 20 }));
    expect(page).toEqual({ items: [{ id: 1 }], page: 3, pageSize: 20, total: 57 });
    expect(calls[0]).toMatchObject({ limit: 20, offset: 40 });
    expect(calls[0].orderBy).toBeDefined();
  });
  it("rejects unknown sort", async () => {
    const { spec: s } = spec();
    await expect(paginate(s, PageQuerySchema.parse({ sort: "email" }))).rejects.toMatchObject({ kind: "bad_request" });
  });
});
