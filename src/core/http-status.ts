export const httpStatus = {
  ok: 200,
  partialContent: 206,
  movedPermanently: 301,
  seeOther: 303,
  notModified: 304,
  badRequest: 400,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  notAcceptable: 406,
  conflict: 409,
  rangeNotSatisfiable: 416,
  unavailable: 503,
} as const;

export type FailureStatus =
  | typeof httpStatus.badRequest
  | typeof httpStatus.forbidden
  | typeof httpStatus.notFound
  | typeof httpStatus.methodNotAllowed
  | typeof httpStatus.notAcceptable
  | typeof httpStatus.conflict
  | typeof httpStatus.unavailable;
