import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { createEmbedding, searchMemory } from '../../pages/api/inbox-assistant';

describe('memory search degradation without OPENAI_API_KEY', () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey) process.env.OPENAI_API_KEY = originalKey;
  });

  it('createEmbedding returns null and makes no network call when the key is unset', async () => {
    // No OpenAI handler is registered for this test -- onUnhandledRequest:'error'
    // means any attempt to actually call the embeddings API fails the test.
    const embedding = await createEmbedding('search this text');
    expect(embedding).toBeNull();
  });

  it('search_memory falls back to keyword-only search and returns results rather than throwing', async () => {
    server.use(
      http.post('https://test-project.supabase.co/rest/v1/rpc/search_memory_chunks_api', () =>
        HttpResponse.json([
          {
            id: 1,
            source_type: 'thread_summary',
            title: 'BECU financial documents',
            chunk_text: 'Grant requested the latest financial documents from BECU.',
            chunk_summary: 'BECU financial docs request',
            updated_at: new Date().toISOString(),
          },
        ])
      )
    );

    const result = await searchMemory({ query: 'BECU financial documents' });

    expect(result.mode).toBe('keyword_full_text');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });
});
