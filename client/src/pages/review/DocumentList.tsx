import { Badge } from '@databricks/appkit-ui/react';
import { shortLabels, type Document } from './lib';

type Props = {
  documents: Document[];
  selected: string | undefined;
  onSelect: (id: string) => void;
};

/**
 * Review queue. The server orders it: most outstanding values first, then the
 * documents the model was least sure about.
 *
 * The badge is a count of work left, never a confidence figure: a per-document
 * average hides the single bad value among good ones, and a minimum reads as
 * "100% done" when every value happens to score 1.0.
 */
export function DocumentList({ documents, selected, onSelect }: Props) {
  const labels = shortLabels(documents.map((d) => d.id));
  const pending = documents.filter((d) => d.n_unreviewed > 0).length;

  return (
    <div className="w-60 shrink-0 overflow-auto border-r p-4">
      {/* Section headings match the app title, so no panel outranks another. */}
      <h2 className="text-lg font-semibold">Documents</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {pending} of {documents.length} pending
      </p>

      {documents.map((doc) => (
        <div
          key={doc.id}
          onClick={() => onSelect(doc.id)}
          className={`mb-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
            doc.id === selected ? 'bg-muted' : 'hover:bg-muted/50'
          }`}
        >
          <span className="flex-1 truncate text-sm" title={doc.id}>
            {labels[doc.id]}
          </span>
          {doc.n_unreviewed > 0 && (
            /* Severity, not progress: red only while something is unresolved. */
            <Badge
              variant={doc.n_unresolved > 0 ? 'destructive' : 'secondary'}
              className="text-[10px]"
              title={`${doc.n_unreviewed} value${doc.n_unreviewed === 1 ? '' : 's'} not yet approved`}
            >
              {doc.n_unreviewed}
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}
