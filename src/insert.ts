import { getAccessToken } from "./auth.js";
import { randomId } from "./types.js";

export interface InsertConfig {
  projectId: string;
}

export interface InsertOptions {
  insertIds?: string[];
  skipInvalidRows?: boolean;
  ignoreUnknownValues?: boolean;
}

export async function insertRows<T extends Record<string, unknown>>(
  config: InsertConfig,
  dataset: string,
  table: string,
  rows: T[],
  options: InsertOptions = {},
): Promise<void> {
  if (rows.length === 0) return;

  const token = await getAccessToken();
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${config.projectId}/datasets/${dataset}/tables/${table}/insertAll`;

  const insertIds = options.insertIds;
  const body = {
    rows: rows.map((json, i) => ({
      json,
      insertId: insertIds?.[i] ?? randomId(),
    })),
    skipInvalidRows: options.skipInvalidRows ?? false,
    ignoreUnknownValues: options.ignoreUnknownValues ?? false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new BqInsertError(
      `BQ insertAll ${dataset}.${table} ${res.status}: ${text}`,
      res.status,
      text,
    );
  }

  const data = (await res.json()) as {
    insertErrors?: Array<{ index: number; errors: Array<{ reason: string; message: string }> }>;
  };

  if (data.insertErrors?.length) {
    throw new BqInsertError(
      `BQ insertAll ${dataset}.${table} row errors: ${JSON.stringify(data.insertErrors)}`,
      200,
      JSON.stringify(data.insertErrors),
    );
  }
}

export class BqInsertError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "BqInsertError";
    this.status = status;
    this.body = body;
  }
}
