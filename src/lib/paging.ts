import { type AnyColumn, type SQL, asc, desc } from "drizzle-orm";
import { z } from "zod";
import { badRequest } from "../shared/errors";

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().trim().max(100).optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const PageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), page: z.number(), pageSize: z.number(), total: z.number() });
export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };

export type PageSpec<TRow> = {
  /** The repository runs the list query. */
  rows: (opts: { orderBy: SQL; limit: number; offset: number }) => Promise<TRow[]>;
  /** The repository runs the count query. */
  count: () => Promise<number>;
  sortable: Record<string, SQL | AnyColumn>;
  defaultSort: string;
};

/** Resolves the requested sort key against the allowlist; unknown keys are a 400. */
export function resolveSort<TRow>(
  spec: Pick<PageSpec<TRow>, "sortable" | "defaultSort">,
  query: Pick<PageQuery, "sort" | "order">,
): { column: SQL | AnyColumn; order: "asc" | "desc"; key: string } {
  const key = query.sort ?? spec.defaultSort;
  if (!Object.hasOwn(spec.sortable, key)) throw badRequest("Orden inválido");
  return { column: spec.sortable[key]!, order: query.order, key };
}

export async function paginate<TRow>(spec: PageSpec<TRow>, query: PageQuery): Promise<Page<TRow>> {
  const { column, order } = resolveSort(spec, query);
  const orderBy = order === "asc" ? asc(column) : desc(column);
  const offset = (query.page - 1) * query.pageSize;
  const [items, total] = await Promise.all([spec.rows({ orderBy, limit: query.pageSize, offset }), spec.count()]);
  return { items, page: query.page, pageSize: query.pageSize, total };
}
