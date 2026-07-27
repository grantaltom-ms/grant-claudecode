import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    env: {
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      AZURE_TENANT_ID: 'test-tenant-id',
      AZURE_CLIENT_ID: 'test-client-id',
      AZURE_CLIENT_SECRET: 'test-client-secret',
      SLACK_BOT_TOKEN: 'test-slack-bot-token',
      SLACK_SIGNING_SECRET: 'test-slack-signing-secret',
      COMPLY_SLACK_BOT_TOKEN: 'test-comply-slack-bot-token',
      COMPLY_SLACK_SIGNING_SECRET: 'test-comply-slack-signing-secret',
      CRON_SECRET: 'test-cron-secret',
    },
  },
});
