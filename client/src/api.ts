export class ApiError extends Error {
  status: number;
  details: string[];
  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  let details: string[] = [];
  try {
    const data = (await response.json()) as { error?: string; details?: string[] };
    if (data.error) message = data.error;
    if (Array.isArray(data.details)) details = data.details;
  } catch {
    /* respuesta sin JSON */
  }
  return new ApiError(response.status, message, details);
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export async function apiSend<T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  user: string | null;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return apiGet<AuthStatus>('/api/auth/status');
}

export async function login(username: string, password: string): Promise<void> {
  await apiSend('/api/auth/login', 'POST', { username, password });
}

export async function logout(): Promise<void> {
  await apiSend('/api/auth/logout', 'POST');
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details.length ? `${error.message}: ${error.details.join('; ')}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function fileUrl(fileId: number): string {
  return `/api/files/${fileId}`;
}
