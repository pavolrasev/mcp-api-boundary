/**
 * The only way this server touches data: the clinic's public API, with the
 * same bearer key any other integration would use. No database, no shortcuts,
 * so it cannot do anything the API would refuse.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Encodes one path segment, so an ID can never add segments of its own. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(query).toString();
    return this.send<T>('GET', search ? `${path}?${search}` : path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', path, body);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError('The clinic system cannot be reached right now. Try again in a moment.', 0);
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      /* The API's own sentence is the most useful thing to hand the model. */
      const message =
        payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
          ? payload.message
          : `The clinic system answered with status ${response.status}.`;
      throw new ApiError(message, response.status);
    }
    return payload as T;
  }
}
