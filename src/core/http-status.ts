export const httpStatus = {
  ok: 200,
  seeOther: 303,
  notModified: 304,
  badRequest: 400,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  notAcceptable: 406,
  conflict: 409,
  unavailable: 503,
} as const;

export type FailureStatus =
  | typeof httpStatus.badRequest
  | typeof httpStatus.notFound
  | typeof httpStatus.methodNotAllowed
  | typeof httpStatus.notAcceptable
  | typeof httpStatus.conflict
  | typeof httpStatus.unavailable;
