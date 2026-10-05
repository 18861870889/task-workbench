export class ApiError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 415 | 503;
  constructor(message: string, status: ApiError['status'] = 400) {
    super(message);
    this.status = status;
  }
}
