/**
 * The `--numstat -z` grammar, parsed in one place.
 *
 * Two callers read per-file line counts out of git: the review diff preview,
 * which reports what a scope changed, and the diff overlay, which reports what
 * each commit changed. They must not disagree about what git said, so they do
 * not each parse it — a second reader of this grammar is a second chance to
 * read a rename or a binary differently, and both are exactly the cases where
 * a hand-rolled parser is wrong.
 *
 * @module numstat
 */

/** One file's line counts. What the field *means* belongs to the caller: the
 * review sources net a range, the overlay's steps churn a single commit. */
export interface NumstatFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Read one `additions \t deletions \t path` record, returning how many fields
 * it spanned. An empty path means git split the name across the next two
 * fields (old then new) — `--no-index` does this for `/dev/null` against a
 * real file even with `--no-renames`, so it is not merely a rename case. The
 * new path is the one that survives, which is the one that exists on disk.
 */
export function consumeNumstatRecord(
  fields: ReadonlyArray<string>,
  index: number,
  field: string,
  into: Array<NumstatFile> | null,
): number {
  const [additions, deletions, name] = field.split("\t");
  if (additions === undefined || deletions === undefined || name === undefined) return 1;
  const width = name === "" ? 3 : 1;
  const path = name === "" ? (fields[index + 2] ?? "") : name;
  if (into !== null && path !== "") {
    // A binary file reports "-" for both counts; it has no lines, so it is
    // still a changed file rather than being dropped.
    into.push({
      path,
      additions: parseCount(additions),
      deletions: parseCount(deletions),
    });
  }
  return width;
}

/** Parse a bare `git diff --numstat -z`, which has no commit headers. */
export function parseNumstat(stdout: string): Array<NumstatFile> {
  const fields = stdout.split("\0");
  const files: Array<NumstatFile> = [];
  let index = 0;
  while (index < fields.length) {
    const field = stripLeadingNewlines(fields[index] ?? "");
    if (field === "") {
      index += 1;
      continue;
    }
    index += consumeNumstatRecord(fields, index, field, files);
  }
  return files;
}

function parseCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function stripLeadingNewlines(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === "\n") start += 1;
  return start === 0 ? value : value.slice(start);
}
