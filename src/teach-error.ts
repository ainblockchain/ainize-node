/**
 * The one error type every visitor-facing teach route throws.
 *
 * `message` starts with the machine-readable code of the design's error table (`dataset_too_large: …`,
 * `quota_rows: …`); `details` is spread into the JSON body by the API error handler so a failed upload can return its
 * per-row report and a quota rejection can return what is left — a bare `{error: string}` cannot.
 *
 * It lives in its own module so the dataset service can throw it without importing the worker (and vice versa).
 */
export class TeachError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}
