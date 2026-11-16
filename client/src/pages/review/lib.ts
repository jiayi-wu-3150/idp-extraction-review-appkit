/**
 * AppKit's generated query types declare SQL numbers as `number` and
 * ARRAY<BIGINT> as `unknown[]`, but the wire delivers strings and a
 * JSON-encoded array, and never models the nulls that occur when the model
 * found nothing for a field. Rows are normalised once here so components only
 * see real numbers, real arrays and explicit nulls.
 */
/**
 * Rows as they arrive from the analytics API. Deliberately not the generated
 * query types: typegen cannot introspect the placeholder table in a fresh
 * clone, so it emits empty types and anything depending on them fails to build.
 */
export type Row = Record<string, unknown>;

const toNumber = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

const toText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  // Nested fields may arrive already parsed; String() would yield
  // "[object Object]", so re-serialise them for display.
  return typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v);
};

const toCoord = (v: unknown): number[] | null => {
  if (v === null || v === undefined || v === '') return null;
  const parts = typeof v === 'string' ? (JSON.parse(v) as unknown[]) : (v as unknown[]);
  return parts.length === 4 ? parts.map(Number) : null;
};

export type FieldMeta = {
  field_name: string;
  value_type: string;
};

export type Field = {
  /** Unique per row: "merchant_name", or "line_items[0].amount" for an array leaf. */
  path: string;
  /** Key into the discovered schema; array leaves share one, index-free. */
  type_key: string;
  /** Set only for flattened array leaves. */
  group_name: string | null;
  item_index: number | null;
  /** The agreed value: this reviewer's correction if any, else the model's. */
  value: string | null;
  /** What the model produced, kept so a correction can show what it replaced. */
  model_value: string | null;
  confidence: number | null;
  /** Review state, scoped to the signed-in reviewer by the query. */
  reviewer: string | null;
  reviewed_at: string | null;
  human_changed: boolean | null;
  /** [x1, y1, x2, y2] in page pixels, or null when there is no citation. */
  coord: number[] | null;
  page_id: number | null;
  image_file: string | null;
};

export type Document = {
  id: string;
  /** Values with no review event yet. The queue badge counts these down to zero. */
  n_unreviewed: number;
  n_unresolved: number;
  min_confidence: number | null;
};

export const toFieldMeta = (r: Row): FieldMeta => ({
  field_name: String(r.field_name),
  value_type: toText(r.value_type) ?? '',
});

export const toField = (r: Row): Field => ({
  path: String(r.path),
  type_key: String(r.type_key),
  group_name: toText(r.group_name),
  item_index: toNumber(r.item_index),
  value: toText(r.value),
  model_value: toText(r.model_value),
  confidence: toNumber(r.confidence),
  reviewer: toText(r.reviewer),
  reviewed_at: toText(r.reviewed_at),
  // SQL booleans arrive as the strings "true"/"false" on the wire.
  human_changed: r.human_changed === null || r.human_changed === undefined
    ? null
    : String(r.human_changed) === 'true',
  coord: toCoord(r.coord),
  page_id: toNumber(r.page_id),
  image_file: toText(r.image_file),
});

export const toDocument = (r: Row): Document => ({
  id: String(r.id),
  n_unreviewed: toNumber(r.n_unreviewed) ?? 0,
  n_unresolved: toNumber(r.n_unresolved) ?? 0,
  min_confidence: toNumber(r.min_confidence),
});

/** Display-only label overrides. Fields absent here fall back to title case. */
const LABELS: Record<string, string> = {};

/** Labels the last path segment, so an array leaf reads "Amount" under its group. */
export const labelFor = (key: string): string =>
  LABELS[key] ?? (key.split('.').pop() ?? key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** The resource key the volume is bound to, used by the files plugin endpoint. */
export const VOLUME_KEY = 'files';

/**
 * Triage bands: the single place confidence thresholds are defined. The badge
 * variant, the box colour on the page image and the legend text are all derived
 * from here, so moving a threshold cannot leave one surface disagreeing with
 * another.
 *
 * The hex values are deliberate, not theme tokens: these colours mark regions
 * on a document image, which is white paper regardless of app theme.
 */
const BAND_DEFS = [
  /** A null confidence means the model found nothing, which always needs review. */
  { key: 'unresolved', min: null, hex: '#dc2626', variant: 'destructive', label: 'needs review' },
  { key: 'low', min: 0, hex: '#ea580c', variant: 'destructive', label: undefined },
  { key: 'medium', min: 0.5, hex: '#ca8a04', variant: 'secondary', label: undefined },
  { key: 'high', min: 0.9, hex: '#16a34a', variant: 'outline', label: undefined },
] as const;

const pct = (n: number) => `${Math.round(n * 100)}%`;

export type Band = {
  key: (typeof BAND_DEFS)[number]['key'];
  label: string;
  hex: string;
  variant: 'destructive' | 'secondary' | 'outline';
};

/** Legend labels generated from the thresholds, so they stay in step with them. */
export const BANDS: Band[] = BAND_DEFS.map((b, i) => {
  const next = BAND_DEFS[i + 1]?.min;
  const label =
    b.label ??
    (next === null || next === undefined
      ? `${pct(b.min as number)}+`
      : b.min === 0
        ? `below ${pct(next)}`
        : `${Math.round((b.min as number) * 100)}-${pct(next)}`);
  return { key: b.key, label, hex: b.hex, variant: b.variant };
});

/** The highest band whose floor the value reaches. Nulls are their own band. */
export function bandOf(confidence: number | null): Band {
  if (confidence === null) return BANDS[0];
  for (let i = BAND_DEFS.length - 1; i >= 0; i--) {
    const min = BAND_DEFS[i].min;
    if (min !== null && confidence >= min) return BANDS[i];
  }
  return BANDS[0];
}

export const hexOf = (confidence: number | null): string => bandOf(confidence).hex;

/** True while a value still wants a human eye: unresolved, or below the top band. */
export const needsAttention = (confidence: number | null): boolean =>
  bandOf(confidence).key !== BANDS[BANDS.length - 1].key;

/** Short, locale-aware stamp for review attribution. */
export const formatReviewedAt = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export type Widget = 'number' | 'text' | 'json';

/**
 * Widget inferred from the discovered schema. No field name is special-cased.
 *
 * Deliberately no dropdown: ai_extract stores `enum` as STRING, so a closed
 * enum is indistinguishable from a string that happens to have few distinct
 * values, and constraining a reviewer to previously-seen values would block
 * the very correction they are here to make.
 *
 * ai_extract can emit objects and arrays (up to 12 levels). Those are shown
 * read-only rather than flattened into a text box that cannot round-trip.
 */
export function widgetFor(meta: FieldMeta): Widget {
  const type = meta.value_type.toUpperCase();
  if (/^(ARRAY|OBJECT|STRUCT|MAP)/.test(type)) return 'json';
  return /^(DECIMAL|BIGINT|INT|SMALLINT|TINYINT|DOUBLE|FLOAT|NUMERIC)/.test(type) ? 'number' : 'text';
}

/** Badge variant for a value, from the same bands as the page overlay. */
export const confidenceVariant = (confidence: number | null): 'destructive' | 'secondary' | 'outline' =>
  bandOf(confidence).variant;

const SEPARATORS = ['_', '-', ' ', '.'];

/** Strip the prefix and suffix shared by every name, aligned to token boundaries. */
function stripSharedAffixes(names: string[]): string[] {
  const shortest = Math.min(...names.map((n) => n.length));

  let prefix = 0;
  while (prefix < shortest && new Set(names.map((n) => n[prefix])).size === 1) prefix++;
  const head = names[0].slice(0, prefix);
  const headCut = Math.max(...SEPARATORS.map((c) => head.lastIndexOf(c)));
  prefix = headCut >= 0 ? headCut + 1 : 0;

  let suffix = 0;
  while (suffix < shortest - prefix && new Set(names.map((n) => n[n.length - 1 - suffix])).size === 1) suffix++;
  const tail = names[0].slice(names[0].length - suffix);
  const tailCuts = SEPARATORS.map((c) => tail.indexOf(c)).filter((i) => i >= 0);
  suffix = tailCuts.length ? suffix - Math.min(...tailCuts) : 0;

  return names.map((n) => n.slice(prefix, n.length - suffix));
}

/**
 * Turn document ids (usually long volume paths sharing a prefix) into short
 * labels. Tries the most aggressive form first and falls back until the labels
 * are unique and non-trivial, so two different documents never share a label.
 */
export function shortLabels(ids: string[]): Record<string, string> {
  if (!ids.length) return {};
  const basenames = ids.map((id) => id.split('/').pop() || id);

  const candidates = ids.length > 1 ? [stripSharedAffixes(basenames), basenames, ids] : [basenames, ids];

  const usable = candidates.find((c) => new Set(c).size === ids.length && c.every((label) => label.length >= 2)) ?? ids;

  return Object.fromEntries(ids.map((id, i) => [id, usable[i]]));
}
