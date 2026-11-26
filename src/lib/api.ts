// Client for the cloud processing backend (see backend/README.md).
import { UserError } from './tool';

/** Base URL of the backend, or undefined when the site was built without one. */
export const API_URL: string | undefined = (import.meta.env.PUBLIC_API_URL as string | undefined)?.replace(/\/+$/, '') || undefined;

const defaultMessages: Record<number, string> = {
  429: 'The server is busy — try again in a few seconds.',
  504: 'Processing took too long. Please try again later.',
};

/**
 * POST `blob` as the raw request body (Content-Type from `blob.type`) and resolve with the response body.
 * `path` may include a query string; `messages` maps endpoint-specific HTTP statuses to user-facing errors.
 * XMLHttpRequest because fetch has no upload progress. `onUploadProgress(1)` fires once the upload is complete.
 */
export function uploadForResult(
  path: string,
  blob: Blob,
  {
    signal,
    onUploadProgress,
    messages = {},
  }: { signal: AbortSignal; onUploadProgress?: (fraction: number) => void; messages?: Record<number, string> },
): Promise<Blob> {
  if (!API_URL) return Promise.reject(new UserError('The cloud service is not configured on this site.'));
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', API_URL + path);
  xhr.responseType = 'blob';
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) onUploadProgress?.(e.loaded / e.total);
  };
  xhr.upload.onload = () => onUploadProgress?.(1);
  xhr.onload = () => {
    if (xhr.status === 200) resolve(xhr.response as Blob);
    else reject(new UserError(messages[xhr.status] ?? defaultMessages[xhr.status] ?? `The server returned an error (${xhr.status}). Please try again later.`));
  };
  xhr.onerror = () => reject(new UserError('Could not reach the server. Check your connection and try again.'));
  xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
  signal.addEventListener('abort', () => xhr.abort(), { once: true });
  xhr.send(blob);
  return promise;
}
