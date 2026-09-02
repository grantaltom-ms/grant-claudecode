import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { getGraphToken } from '../../lib/graph';
import {
  TRIAGE_FOLDERS,
  listMailFolders,
  createMailFolder,
  moveMessageToFolder,
  resolveTriageFolderId,
} from '../../lib/mailbox-folders';

const OWNER = 'grant@milestoneproperties.net';

describe('listMailFolders', () => {
  it('lists top-level folders by default', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders', () =>
        HttpResponse.json({ value: [{ id: 'f1', displayName: 'Inbox' }] })
      )
    );

    const token = await getGraphToken();
    const folders = await listMailFolders(token, OWNER);
    expect(folders).toEqual([{ id: 'f1', displayName: 'Inbox' }]);
  });

  it('lists child folders under a given parent', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () =>
        HttpResponse.json({ value: [{ id: 'f2', displayName: 'Waiting On' }] })
      )
    );

    const token = await getGraphToken();
    const folders = await listMailFolders(token, OWNER, 'Inbox');
    expect(folders).toEqual([{ id: 'f2', displayName: 'Waiting On' }]);
  });
});

describe('createMailFolder', () => {
  it('creates a folder under a parent when given one', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 'f3', displayName: requestBody.displayName });
      })
    );

    const token = await getGraphToken();
    const folder = await createMailFolder(token, OWNER, 'Snoozed', 'Inbox');
    expect(folder).toEqual({ id: 'f3', displayName: 'Snoozed' });
  });
});

describe('moveMessageToFolder', () => {
  it('posts a move with the destination folder id', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/move', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 'msg-1' });
      })
    );

    const token = await getGraphToken();
    await moveMessageToFolder(token, OWNER, 'msg-1', 'folder-abc');
    expect(requestBody).toEqual({ destinationId: 'folder-abc' });
  });
});

function fakeSupabase({ cachedFolderId = null } = {}) {
  const upsertCalls = [];
  return {
    upsertCalls,
    from(table) {
      expect(table).toBe('mailbox_folders');
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: cachedFolderId ? { graph_folder_id: cachedFolderId } : null }),
        upsert: async (row) => { upsertCalls.push(row); return { data: null, error: null }; },
      };
    },
  };
}

describe('resolveTriageFolderId', () => {
  it('returns the cached folder id without listing or creating anything', async () => {
    const supabase = fakeSupabase({ cachedFolderId: 'cached-folder-id' });
    const token = await getGraphToken();

    const id = await resolveTriageFolderId(supabase, token, OWNER, 'waiting_on');
    expect(id).toBe('cached-folder-id');
    expect(supabase.upsertCalls).toEqual([]);
  });

  it('reuses an existing folder found by display name instead of creating a duplicate', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () =>
        HttpResponse.json({ value: [{ id: 'existing-id', displayName: TRIAGE_FOLDERS.needs_reply }] })
      )
    );
    const createSpy = vi.fn();
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () => {
        createSpy();
        return HttpResponse.json({ id: 'should-not-be-created' });
      })
    );

    const supabase = fakeSupabase();
    const token = await getGraphToken();
    const id = await resolveTriageFolderId(supabase, token, OWNER, 'needs_reply');

    expect(id).toBe('existing-id');
    expect(createSpy).not.toHaveBeenCalled();
    expect(supabase.upsertCalls).toEqual([
      { owner_email: OWNER, folder_key: 'needs_reply', display_name: 'Needs Reply', graph_folder_id: 'existing-id' },
    ]);
  });

  it('creates the folder when it does not exist yet, then caches it', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () =>
        HttpResponse.json({ value: [] })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', async ({ request }) => {
        const body = await request.json();
        return HttpResponse.json({ id: 'new-folder-id', displayName: body.displayName });
      })
    );

    const supabase = fakeSupabase();
    const token = await getGraphToken();
    const id = await resolveTriageFolderId(supabase, token, OWNER, 'snoozed');

    expect(id).toBe('new-folder-id');
    expect(supabase.upsertCalls).toEqual([
      { owner_email: OWNER, folder_key: 'snoozed', display_name: 'Snoozed', graph_folder_id: 'new-folder-id' },
    ]);
  });

  it('throws for an unknown triage key', async () => {
    const supabase = fakeSupabase();
    const token = await getGraphToken();
    await expect(resolveTriageFolderId(supabase, token, OWNER, 'bogus')).rejects.toThrow('Unknown triage folder');
  });
});
