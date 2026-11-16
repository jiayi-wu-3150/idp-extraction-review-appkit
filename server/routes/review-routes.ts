import { z } from 'zod';
import type { Application, Request } from 'express';
import { sql } from '@databricks/appkit';

/**
 * The review write path.
 *
 * Deliberately a server route rather than a `config/queries/*.sql` file: every
 * file there is reachable from the browser at `POST /api/analytics/query/:key`
 * with arbitrary parameters, so a query that takes `reviewer` as a parameter
 * would let a client forge who approved what in an audit table. Here the
 * reviewer comes from the `X-Forwarded-Email` header that Databricks Apps sets,
 * and is never accepted from the request body.
 *
 * The statement is append-only and never touches the extraction table, so the
 * log is an audit trail and a labelled eval dataset at the same time. The
 * `<extraction>_reviewed` view in `setup/setup.sql` resolves it to final values.
 */

const ReviewedValue = z.object({
  /** Row identity from `document.sql`: "merchant_name" or "line_items[0].amount". */
  path: z.string().min(1),
  original: z.string().nullable(),
  corrected: z.string().nullable(),
  confidence: z.number().nullable(),
});

const ReviewBody = z.object({
  document_id: z.string().min(1),
  values: z.array(ReviewedValue).min(1),
});

/** Env-supplied table names are identifiers, so they cannot be bound as parameters. */
const QUALIFIED_NAME = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

const insertStatement = (table: string) => `
INSERT INTO ${table}
SELECT
  current_timestamp()                                 AS reviewed_at,
  :reviewer                                           AS reviewer,
  :document_id                                        AS document_id,
  variant_get(v, '$.path', 'STRING')                  AS field_path,
  variant_get(v, '$.original', 'STRING')              AS original_value,
  variant_get(v, '$.corrected', 'STRING')             AS corrected_value,
  variant_get(v, '$.confidence', 'DOUBLE')            AS confidence,
  NOT (variant_get(v, '$.original', 'STRING') <=> variant_get(v, '$.corrected', 'STRING')) AS changed
FROM (SELECT explode(from_json(:values_json, 'ARRAY<VARIANT>')) AS v)`;

interface AppKitWithAnalytics {
  analytics: {
    query(statement: string, parameters?: Record<string, unknown>): Promise<unknown>;
  };
  asUser(req: Request): AppKitWithAnalytics;
  server: { extend(fn: (app: Application) => void): void };
}

/**
 * Attribution is never a knob. In a deployed app the header is always present;
 * locally there is no proxy, so development falls back to a marked identity
 * rather than silently logging an empty reviewer.
 */
function reviewerOf(req: Request): string | null {
  const header = req.header('X-Forwarded-Email') ?? req.header('X-Forwarded-Preferred-Username');
  if (header) return header;
  return process.env.NODE_ENV === 'development' ? 'local-dev@localhost' : null;
}

export function setupReviewRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    app.post('/api/review', async (req, res) => {
      const table = process.env.REVIEW_LOG_TABLE;
      if (!table || !QUALIFIED_NAME.test(table)) {
        res.status(500).json({
          error: 'REVIEW_LOG_TABLE must be set to a catalog.schema.table name',
        });
        return;
      }

      const reviewer = reviewerOf(req);
      if (!reviewer) {
        res.status(401).json({ error: 'No authenticated user on the request' });
        return;
      }

      const parsed = ReviewBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid review payload' });
        return;
      }

      try {
        // asUser so Unity Catalog sees the reviewer, not the service principal.
        await appkit.asUser(req).analytics.query(insertStatement(table), {
          reviewer: sql.string(reviewer),
          document_id: sql.string(parsed.data.document_id),
          values_json: sql.string(JSON.stringify(parsed.data.values)),
        });
        res.json({ document_id: parsed.data.document_id, logged: parsed.data.values.length });
      } catch (err) {
        console.error('Failed to log review:', err);
        res.status(500).json({ error: 'Failed to log review' });
      }
    });
  });
}
