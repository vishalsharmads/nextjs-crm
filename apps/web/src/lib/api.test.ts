import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'csrf_token=; Max-Age=0; path=/';
});

describe('api CSRF recovery', () => {
  it('drops a rejected token and retries once with a fresh one, even with noRetry', async () => {
    document.cookie = 'csrf_token=stale; path=/';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(403, { error: { code: 'CSRF_INVALID', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { token: 'fresh' }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/auth/login', { method: 'POST', body: {}, noRetry: true })).resolves.toEqual({
      ok: true,
    });
    const sent = (i: number) =>
      (fetchMock.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
    expect(sent(0)['x-csrf-token']).toBe('stale');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/auth/csrf');
    expect(sent(2)['x-csrf-token']).toBe('fresh');
  });

  it('gives up after one retry', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes('/auth/csrf')
            ? json(200, { token: 'fresh' })
            : json(403, { error: { code: 'CSRF_INVALID', message: 'expired' } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    document.cookie = 'csrf_token=stale; path=/';
    await expect(api('/x', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403 });
    // The first attempt, a token fetch and one retry: no loop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
