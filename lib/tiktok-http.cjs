'use strict';

async function requestJSON(fetcher, url, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  controller.signal.addEventListener('abort', () => rejectAbort(new Error('aborted')), { once: true });
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.timeout || 10000);
  let reader;
  try {
    if (controller.signal.aborted) throw new Error();
    const request = Promise.resolve(fetcher(url, {
      method: options.method || 'GET', headers: { Accept: 'application/json', ...options.headers },
      body: options.body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store'
    })).then(response => {
      if (controller.signal.aborted) response.body?.cancel().catch(() => {});
      return response;
    });
    const response = await Promise.race([request, aborted]);
    if (!response.body) throw new Error();
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (controller.signal.aborted) throw new Error();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > (options.limit || 65536)) throw new Error();
      chunks.push(Buffer.from(chunk.value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return { status: response.status, body };
  } catch {
    throw new Error(controller.signal.aborted ? 'The connection request was cancelled or timed out.' : 'The connection service could not return valid data.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (reader) { reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Pending read was cancelled. */ } }
  }
}
module.exports = { requestJSON };
