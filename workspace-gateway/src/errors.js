export class HttpError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function asHttpError(error) {
  if (error instanceof HttpError) {
    return error;
  }
  const wrapped = new HttpError(500, "internal_error", "Internal server error");
  wrapped.cause = error;
  return wrapped;
}
