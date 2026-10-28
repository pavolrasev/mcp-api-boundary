import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { issueApiKey } from './auth.js';
import { ROLE_SCOPES } from './scopes.js';
import { createDemoStore } from './seed.js';

const port = Number(process.env['PORT'] ?? 8787);
const store = createDemoStore();

/*
  One key for the receptionist, with everything her role allows. Set
  DEMO_API_KEY to keep the same secret across restarts; otherwise a new one
  is printed every time. Only its hash is kept in memory.
*/
const { secret } = issueApiKey(store, 'mem_reception', [...ROLE_SCOPES.receptionist], {
  label: 'Assistant (demo)',
  ...(process.env['DEMO_API_KEY'] ? { secret: process.env['DEMO_API_KEY'] } : {}),
});

serve({ fetch: createApp({ store }).fetch, port }, (info) => {
  console.log(`Demo clinic API on http://localhost:${info.port}`);
  console.log(`Receptionist API key: ${secret}`);
});
