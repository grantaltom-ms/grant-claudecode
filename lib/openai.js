// lib/openai.js
// Shared low-level OpenAI embeddings call. The two callers
// (pages/api/inbox-assistant.js, pages/api/backfill-memory-chunks.js) have
// different return-shape contracts for their own createEmbedding() (one
// returns the embedding array or null, the other returns
// {embedding, error, status}) so this only consolidates the actual network
// call + retry behavior, not the two callers' differing error handling.

import { withRetry } from './retry';

export async function fetchEmbedding(input, model) {
  return withRetry(async () => {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input }),
    });

    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.error?.message || `OpenAI embedding request failed with status ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return data;
  }, { label: 'openai embeddings' });
}
