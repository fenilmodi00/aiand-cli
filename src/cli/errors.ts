/** Process exit codes; README "Exit codes" documents each one. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  /** Not signed in, or the session could not be refreshed. */
  NOT_SIGNED_IN: 2,
  /** Login denied in the browser, or the device code expired. */
  LOGIN_DENIED: 3,
  /** A bug in the CLI (EX_SOFTWARE). */
  BUG: 70,
  /** Unknown command or missing agent binary. */
  NOT_FOUND: 127,
  // --- Observability automation contract (G5, ticket #71; `aiand status`
  // --format/--write-state) — additive; never renumber these. ---
  /** Budget pacing: at or above the near-limit threshold, or projected to exceed. */
  NEAR_LIMIT: 10,
  /** Budget pacing: the budget is fully used. */
  LIMIT_HIT: 11,
  /** Budget set but the data behind the verdict is incomplete or untrustworthy. */
  INDETERMINATE: 20,
  /** The local store is empty or has never synced — there is nothing to gate on. */
  NO_DATA: 30,
  /** Interrupted: SIGINT / Ctrl-C (128 + 2). */
  INTERRUPTED: 130,
  /** Terminated: SIGTERM (128 + 15). */
  TERMINATED: 143,
} as const;

/**
 * Status codes the CLI assigns itself when there is no usable HTTP response.
 * UNREACHABLE: the request never got an answer (network failure).
 * BAD_GATEWAY: the gateway answered with a body that is not valid JSON.
 */
export const SYNTHETIC_STATUS = {
  UNREACHABLE: 0,
  BAD_GATEWAY: 502,
} as const;

export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, opts: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = opts.exitCode ?? EXIT.ERROR;
    this.hint = opts.hint;
  }
}

export const CANCELLED_MESSAGE = "Cancelled.";
export const LOGIN_CANCELLED_MESSAGE = "Login cancelled.";

/** The user cancelled (Ctrl-C, Esc): exit 130 with a one-line message. */
export function cancelled(): CliError {
  return new CliError(CANCELLED_MESSAGE, { exitCode: EXIT.INTERRUPTED });
}

/** A sign-in the user cancelled mid-flow. */
export function loginCancelled(): CliError {
  return new CliError(LOGIN_CANCELLED_MESSAGE, { exitCode: EXIT.INTERRUPTED });
}

export class NotLoggedInError extends CliError {
  constructor() {
    super("Not logged in.", { exitCode: EXIT.NOT_SIGNED_IN, hint: "Run `aiand login` first." });
    this.name = "NotLoggedInError";
  }
}

export class ApiError extends CliError {
  readonly status: number;
  readonly requestId?: string;
  readonly type?: string;

  constructor(
    status: number,
    message: string,
    opts: { requestId?: string; type?: string; hint?: string } = {},
  ) {
    super(message, { exitCode: EXIT.ERROR, hint: opts.hint });
    this.name = "ApiError";
    this.status = status;
    this.requestId = opts.requestId;
    this.type = opts.type;
  }
}
