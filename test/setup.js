import { afterEach, afterAll } from 'vitest';
import { server } from './mocks/server';

// listen() runs at module top-level, not inside beforeAll: Vitest's setup
// files execute before a test file's own static imports resolve, but a
// beforeAll callback only fires after those imports (and any module-load-time
// client construction, like lib/supabase.js's createClient() call) have
// already happened. @supabase/supabase-js resolves its fetch implementation
// once at client-construction time rather than per-call, so listen() has to
// win that race -- deferring it into beforeAll silently left every Supabase
// client built at import time talking to the real network instead of MSW.
//
// No test should ever make a real network call -- onUnhandledRequest 'error'
// turns an unmocked request into a hard failure instead of a silent live call.
server.listen({ onUnhandledRequest: 'error' });
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
