import { resolvePocketFileId } from './driveClient';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('resolvePocketFileId', () => {
  const FILE_NAME = 'arkode-pocket-sync.json';

  it('uses the hinted id directly when it resolves and is not trashed', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ id: 'current-id', trashed: false }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const id = await resolvePocketFileId('token', { fileId: 'current-id', fileName: FILE_NAME });

    expect(id).toBe('current-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a name search when the hinted id no longer resolves at all', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: 'fresh-id', name: FILE_NAME }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const id = await resolvePocketFileId('token', { fileId: 'deleted-id', fileName: FILE_NAME });

    expect(id).toBe('fresh-id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The real production bug this locks in: Desktop's publish flow sends the
   * PREVIOUS revision to Google Drive's Trash rather than hard-deleting it.
   * Drive still serves a trashed file's content via `files.get`/`alt=media`
   * with no error — so a hint pointing at a now-superseded, trashed file
   * must be treated exactly like a hint that doesn't resolve at all,
   * falling through to the name search (which itself already filters
   * `trashed = false`). Without this, a paired device would silently and
   * permanently re-download stale content forever after the very next
   * publish, no matter how many times Desktop republishes.
   */
  it('falls back to a name search when the hinted id resolves but is TRASHED', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'old-trashed-id', trashed: true }))
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: 'fresh-id', name: FILE_NAME }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const id = await resolvePocketFileId('token', { fileId: 'old-trashed-id', fileName: FILE_NAME });

    expect(id).toBe('fresh-id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when there is no hint and no file found by name', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ files: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolvePocketFileId('token', { fileId: null, fileName: FILE_NAME })).rejects.toThrow(/no se encontró/i);
  });
});
