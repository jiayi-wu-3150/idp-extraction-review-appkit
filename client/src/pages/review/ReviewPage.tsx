import { useEffect, useRef, useState } from 'react';
import { useAnalyticsQuery, Skeleton } from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { DocumentList } from './DocumentList';
import { OverviewBox, OverviewPages } from './Overview';
import { PageViewer } from './PageViewer';
import { FieldList } from './FieldList';
import { formatReviewedAt, shortLabels, toDocument, toField, toFieldMeta, widgetFor, type Row } from './lib';

export function ReviewPage() {
  const [docId, setDocId] = useState<string>();
  const [fieldPath, setFieldPath] = useState<string>();
  // Every document opens on the overview.
  const [view, setView] = useState<'overview' | 'review'>('overview');
  /** Reviewer edits for the open document, keyed by field path. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  /*
    Documents approved in this session, with the moment it happened.
    `useAnalyticsQuery` exposes no refetch and a remount reuses the cached
    snapshot, so the just-written state is reflected locally until the next
    load. Durable state still comes from the log, so a refresh loses nothing.
  */
  const [approvedAt, setApprovedAt] = useState<Record<string, string>>({});

  const schema = useAnalyticsQuery('fields');
  const queue = useAnalyticsQuery('documents');
  const detail = useAnalyticsQuery('document', { doc_id: sql.string(docId ?? '') });

  const schemaRows = ((schema.data ?? []) as Row[]).map(toFieldMeta);
  const documents = ((queue.data ?? []) as Row[])
    .map(toDocument)
    .map((d) => (d.id in approvedAt ? { ...d, n_unreviewed: 0, n_unresolved: 0 } : d))
    .sort((a, b) => b.n_unreviewed - a.n_unreviewed || b.n_unresolved - a.n_unresolved);
  const fields = ((detail.data ?? []) as Row[]).map(toField);

  /*
    Select the top of the queue exactly once, and only once the queue is
    complete. Two traps here: the request store's idle snapshot reports
    `loading: false` with no rows before the request even starts, and in
    StrictMode this effect runs twice, so a queue that finishes loading between
    the two runs would select a different document on each. The ref makes the
    choice final; the reviewer is in charge after that.
  */
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current || docId || queue.loading || !documents.length) return;
    autoSelected.current = true;
    setDocId(documents[0].id);
  }, [docId, queue.loading, documents]);

  const error = schema.error ?? queue.error ?? detail.error;
  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
        <p className="font-semibold">{error}</p>
        <p className="mt-1 text-xs">
          If this is a fresh install, replace <code>REPLACE_ME</code> in <code>config/queries/*.sql</code> with your
          ai_extract output table (<code>catalog.schema.table</code>), then restart.
        </p>
      </div>
    );
  }
  if (queue.loading || schema.loading) {
    return <Skeleton className="h-96 w-full" />;
  }

  const selectedField = fields.find((f) => f.path === fieldPath) ?? fields[0];

  // Choosing a region or a field leaves the overview for field review.
  const select = (path: string) => {
    setFieldPath(path);
    setView('review');
  };
  const label = docId ? shortLabels(documents.map((d) => d.id))[docId] : '';

  /*
    Whether this reviewer has already reviewed the document comes from the log
    via `document.obo.sql`, not from session state: after a refresh the app has
    no memory, but the data does. Every countable value must carry a review
    stamp, so a partially reviewed document still reads as outstanding.
  */
  const countable = fields.filter((f) => {
    const meta = schemaRows.find((m) => m.field_name === f.type_key);
    return !meta || widgetFor(meta) !== 'json';
  });
  const loggedReviewedAt =
    countable.length > 0 && countable.every((f) => f.reviewed_at !== null)
      ? countable
          .map((f) => f.reviewed_at!)
          .sort()
          .at(-1)!
      : null;
  /*
    The optimistic marker covers the gap between a successful write and the next
    load. Without it the button falls back to "Approve" right after a successful
    approve, which invites a second, duplicate submission.
  */
  const reviewedAt = loggedReviewedAt ?? (docId ? (approvedAt[docId] ?? null) : null);
  const reviewedBy = countable.find((f) => f.reviewer !== null)?.reviewer ?? null;

  /*
    One row per reviewable value, agreed ones included: the log records that a
    human looked and accepted, not only the corrections. Read-only nested
    fields are left out, since `documents.sql` does not count them either and
    including them would leave the queue count unreachable.
  */
  const approve = async () => {
    if (!docId) return;
    const payload = fields
      .filter((f) => {
        const meta = schemaRows.find((m) => m.field_name === f.type_key);
        return !meta || widgetFor(meta) !== 'json';
      })
      .map((f) => ({
        path: f.path,
        original: f.value,
        corrected: edits[f.path] ?? f.value,
        confidence: f.confidence,
      }));

    setApproving(true);
    setApproveError(null);
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: docId, values: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed with ${res.status}`);
      }
      setApprovedAt((prev) => ({ ...prev, [docId]: new Date().toISOString() }));
      // The write is recorded; drop the local edits so the form reflects the
      // log and the button falls back to its idle state.
      setEdits({});
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] overflow-hidden rounded-lg border bg-background">
      <DocumentList
        documents={documents}
        selected={docId}
        onSelect={(id) => {
          setDocId(id);
          setFieldPath(undefined);
          setView('overview');
          setEdits({});
          setApproveError(null);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The id is a volume path that shares a long prefix with every other
          document, so it gets its own line at full length rather than an
          ellipsis: truncating the head hides where the file lives, truncating
          the tail hides which file it is. `break-all` keeps even a very deep
          path inside the pane.
        */}
        <div className="border-b px-4 py-2">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold">{label}</span>
            {reviewedAt && (
              <span className="text-xs text-muted-foreground">
                Reviewed by {reviewedBy ?? 'you'} · {formatReviewedAt(reviewedAt)}
              </span>
            )}
          </div>
          <div className="break-all text-xs text-muted-foreground">{docId}</div>
        </div>
        {detail.loading ? (
          <Skeleton className="m-4 flex-1" />
        ) : view === 'overview' ? (
          <OverviewPages fields={fields} onSelect={select} />
        ) : (
          <PageViewer fields={fields} selected={selectedField} />
        )}
      </div>

      <div className="flex w-80 shrink-0 flex-col overflow-hidden border-l p-4">
        <OverviewBox fields={fields} active={view === 'overview'} onClick={() => setView('overview')} />
        <FieldList
          fields={fields}
          schema={schemaRows}
          selected={view === 'review' ? selectedField?.path : undefined}
          onSelect={select}
          edits={edits}
          onEdit={(path, value) => setEdits((prev) => ({ ...prev, [path]: value }))}
          onApprove={approve}
          approving={approving}
          reviewedAt={reviewedAt}
          error={approveError}
        />
      </div>
    </div>
  );
}
