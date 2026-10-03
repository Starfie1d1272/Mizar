import { expect, it, vi } from 'vitest';
import { BilibiliStatus, bilibiliRoomId } from '../src/platform/bilibili.js';

it('accepts only numeric rooms on the configured HTTPS provider', () => {
  expect(bilibiliRoomId('https://live.bilibili.com/123?from=share')).toBe('123');
  for (const value of [
    'http://live.bilibili.com/123',
    'https://evil.test/123',
    'https://user@live.bilibili.com/123',
    'https://live.bilibili.com:444/123',
    'https://live.bilibili.com/abc',
  ])
    expect(bilibiliRoomId(value)).toBeNull();
});
it('deduplicates concurrent windows, caches and retries unknown results after expiry', async () => {
  let now = 0;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { live_status: 1 } })));
  const service = new BilibiliStatus(fetcher, () => now);
  const urls = ['https://live.bilibili.com/123'];
  expect(await Promise.all([service.read(urls), service.read(urls)])).toEqual(['live', 'live']);
  expect(await service.read(urls)).toBe('live');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    'https://api.live.bilibili.com/room/v1/Room/room_init?id=123',
  );
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  now = 30_001;
  fetcher.mockRejectedValue(new Error('offline'));
  expect(await service.read(urls)).toBe('unknown');
  expect(await service.read(urls)).toBe('unknown');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('keeps invalid results unknown and distinguishes missing rooms from offline rooms', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation((url) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return Promise.resolve(
      new Response(
        JSON.stringify(
          address.endsWith('123') ? { code: 0, data: { live_status: 0 } } : { code: -1 },
        ),
      ),
    );
  });
  const service = new BilibiliStatus(fetcher);
  expect(await service.read([])).toBe('unconfigured');
  expect(await service.read(['https://live.bilibili.com/123'])).toBe('offline');
  expect(
    await service.read(['https://live.bilibili.com/123', 'https://live.bilibili.com/456']),
  ).toBe('unknown');
});

it('bounds untrusted responses and treats HTTP failures as unknown', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('x'.repeat(64_001)))
    .mockResolvedValueOnce(new Response('', { status: 429 }));
  const service = new BilibiliStatus(fetcher);
  expect(await service.read(['https://live.bilibili.com/1'])).toBe('unknown');
  expect(await service.read(['https://live.bilibili.com/2'])).toBe('unknown');
});
