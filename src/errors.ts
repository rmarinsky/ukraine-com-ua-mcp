/**
 * Error returned by the adm.tools API or by transport-level failures.
 *
 * `status`         — HTTP status code, or `0` for network/timeout failures.
 * `action`         — adm.tools action path (e.g. `dns/list`).
 * `apiError`       — the `error` object from the JSON response (when present).
 * `cause`          — original underlying error, when chained from network/abort.
 */
export class AdmToolsError extends Error {
	readonly status: number;
	readonly action: string;
	readonly apiError: unknown;
	override readonly cause?: unknown;

	constructor(
		message: string,
		opts: {
			status: number;
			action: string;
			apiError?: unknown;
			cause?: unknown;
		},
	) {
		super(message);
		this.name = "AdmToolsError";
		this.status = opts.status;
		this.action = opts.action;
		this.apiError = opts.apiError;
		this.cause = opts.cause;
	}
}

/**
 * Thrown specifically when the API rejects the bearer token (HTTP 401, 403,
 * or a JSON-level "auth" error). Distinct from {@link AdmToolsError} so that
 * callers can detect "token bad / re-prompt user" vs other failures.
 */
export class AdmToolsAuthError extends AdmToolsError {
	constructor(message: string, opts: { status: number; action: string; apiError?: unknown }) {
		super(message, opts);
		this.name = "AdmToolsAuthError";
	}
}

/**
 * Raised when a `backup_id` precondition fails: the backup file is missing,
 * stale (older than `ADM_TOOLS_BACKUP_MAX_AGE_MS`), or its hash no longer
 * matches the current zone state. `hint` is a human-readable next step.
 */
export class BackupError extends Error {
	readonly hint?: string;

	constructor(message: string, hint?: string) {
		super(message);
		this.name = "BackupError";
		this.hint = hint;
	}
}
