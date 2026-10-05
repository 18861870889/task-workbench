export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new ApiError('无法连接服务器。请检查网络；本次操作尚未确认保存。', 0);
  }
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && path !== '/session') window.dispatchEvent(new Event('sessionexpired'));
    throw new ApiError(result.error || (response.status === 409 ? '任务已在其他地方更新。请重新载入后再修改。' : `请求失败（${response.status}）`), response.status);
  }
  return result as T;
}

export const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';

// XHR exposes upload progress; a stable upload ID makes a retry safe after a lost response.
export function uploadAttachment(taskId: string, file: File, uploadId: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/tasks/${encodeURIComponent(taskId)}/attachments`);
    request.withCredentials = true;
    request.timeout = 15 * 60 * 1000;
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    request.setRequestHeader('X-File-Size', String(file.size));
    request.setRequestHeader('X-Upload-Id', uploadId);
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100))); };
    request.onload = () => {
      let result: { error?: string } = {};
      try { result = JSON.parse(request.responseText); } catch { /* Use the HTTP status if the response is not JSON. */ }
      if (request.status >= 200 && request.status < 300) { resolve(); return; }
      if (request.status === 401) window.dispatchEvent(new Event('sessionexpired'));
      reject(new ApiError(result.error || `上传失败（${request.status}）`, request.status));
    };
    request.onerror = () => reject(new ApiError('网络中断，上传结果尚未确认。可重试此文件，不会重复添加已保存的附件。', 0));
    request.ontimeout = () => reject(new ApiError('上传超时，结果尚未确认。请检查网络后重试此文件。', 0));
    request.onabort = () => reject(new ApiError('上传已中断，可以重试此文件。', 0));
    request.send(file);
  });
}
