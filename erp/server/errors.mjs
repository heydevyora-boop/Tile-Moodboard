/* ============================================================
   THE ERRORS THE API SPEAKS
   ============================================================
   Each carries an HTTP status and, where it is a validation
   failure, the FIELDS that failed. "Validation failed" with no
   field named is the error message that wastes the most time in
   this industry; every rejection here says which field and why.
   ============================================================ */

export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  /** @param {{field: string, message: string}[]} fields */
  constructor(fields, message = 'The record is incomplete or invalid.') {
    super(message, { status: 422, code: 'VALIDATION_FAILED', details: { fields } });
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export class NotFoundError extends AppError {
  constructor(what) {
    super(what + ' not found.', { status: 404, code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message, details) {
    super(message, { status: 409, code: 'CONFLICT', details });
    this.name = 'ConflictError';
  }
}

/**
 * A duplicate the system will NOT decide about.
 *
 * The brief is explicit: ambiguous matches require human review.
 * So a near-match is not merged and not silently accepted — it is
 * returned, with the candidates, for a person to look at. The
 * caller can proceed by saying so explicitly.
 */
export class NeedsReviewError extends AppError {
  constructor(message, candidates) {
    super(message, {
      status: 409,
      code: 'NEEDS_HUMAN_REVIEW',
      details: {
        candidates,
        resolution: 'Review the candidates. To create this anyway, resend with confirmDistinct: true.',
      },
    });
    this.name = 'NeedsReviewError';
  }
}
