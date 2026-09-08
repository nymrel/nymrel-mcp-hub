export class NymrelRemoteError extends Error {
  constructor(message, { code = 'REMOTE_ERROR', status = 400, data = undefined } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export class NotFoundError extends NymrelRemoteError {
  constructor(message = 'Not found', data) { super(message, { code: 'NOT_FOUND', status: 404, data }); }
}
export class ConflictError extends NymrelRemoteError {
  constructor(message = 'Conflict', data) { super(message, { code: 'CONFLICT', status: 409, data }); }
}
export class UnauthorizedError extends NymrelRemoteError {
  constructor(message = 'Unauthorized', data) { super(message, { code: 'UNAUTHORIZED', status: 401, data }); }
}
export class ForbiddenError extends NymrelRemoteError {
  constructor(message = 'Forbidden', data) { super(message, { code: 'FORBIDDEN', status: 403, data }); }
}
export class PolicyDeniedError extends NymrelRemoteError {
  constructor(message = 'Tool call denied by policy', data) { super(message, { code: 'POLICY_DENIED', status: 403, data }); }
}
