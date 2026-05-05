import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

// Lightweight signature checks against sql/tables.sql so a revert to
// the simple `ARRAY_AGG(traits ORDER BY ts DESC LIMIT 1)` pattern
// (which clobbers earlier traits whenever a later partial write lands)
// fails CI without needing a live BQ roundtrip.
//
// Behavior is end-to-end-tested in tests/integration/bq.test.ts but
// that suite is gated on BQ_INTEGRATION=1 and won't catch a regression
// in CI. These shape tests are the cheap regression net.

const here = dirname(fileURLToPath(import.meta.url));
const tablesPath = resolve(here, "../sql/tables.sql");

function viewBody(sql: string, viewName: string): string {
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+VIEW\\s+\`@@EVENTS_DATASET@@\\.${viewName}\`\\s+AS([\\s\\S]*?);`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`view ${viewName} not found in tables.sql`);
  return m[1]!;
}

describe("sql/tables.sql view DDL", () => {
  let sql: string;
  beforeAll(() => {
    sql = readFileSync(tablesPath, "utf8");
  });

  for (const view of ["users", "groups_current"] as const) {
    describe(`${view} view`, () => {
      let body: string;
      beforeAll(() => {
        body = viewBody(sql, view);
      });

      it("explodes traits per key with JSON_KEYS + UNNEST", () => {
        // The per-key merge pattern requires unrolling each row's
        // top-level JSON keys and looking up the value with subscript
        // syntax (BQ rejects runtime json paths in JSON_QUERY/EXTRACT).
        expect(body).toMatch(/JSON_KEYS\s*\(\s*traits\s*,\s*1\s*\)/);
        expect(body).toMatch(/traits\[\s*k\s*\]/);
      });

      it("aggregates latest non-clobbered value per key", () => {
        // The smoking-gun anti-pattern: ARRAY_AGG of the whole traits
        // column ordered by ts. That's the bug we're regression-testing
        // against — it picks the latest row's traits wholesale, so an
        // empty `{}` write erases everything written before.
        expect(body).not.toMatch(
          /ARRAY_AGG\s*\(\s*traits\s+ORDER\s+BY\s+ts\s+DESC\s+LIMIT\s+1\s*\)/i,
        );
        // What we expect instead: per-key ARRAY_AGG of value_json.
        expect(body).toMatch(
          /ARRAY_AGG\s*\(\s*value_json\s+ORDER\s+BY\s+ts\s+DESC\s+LIMIT\s+1\s*\)/i,
        );
      });

      it("rebuilds the merged JSON object with STRING_AGG + SAFE.PARSE_JSON", () => {
        expect(body).toMatch(/STRING_AGG/);
        expect(body).toMatch(/SAFE\.PARSE_JSON/);
      });

      it("returns JSON '{}' rather than NULL for groups with only empty traits writes", () => {
        // Empty traits writes contribute zero rows to the merged CTE,
        // so the LEFT JOIN must coalesce to an empty JSON object so the
        // group still appears in the view.
        expect(body).toMatch(/COALESCE\s*\(\s*m\.traits\s*,\s*JSON\s+'\{\}'\s*\)/i);
      });
    });
  }
});
