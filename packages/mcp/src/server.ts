import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient, type Fetch } from './api-client.js';
import type { Clock } from './dates.js';
import { registerTools } from './tools.js';

export interface ServerOptions {
  apiUrl: string;
  apiKey: string;
  clock?: Clock;
  fetch?: Fetch;
}

export function createServer({ apiUrl, apiKey, clock, fetch }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'clinic-reception', version: '0.1.0' },
    {
      instructions:
        'Front-desk tools for a physiotherapy clinic. Look a client up before booking and book by ID. ' +
        'Clinical records, notes, photos and questionnaires are not available here.',
    },
  );
  registerTools(server, {
    api: new ApiClient(apiUrl, apiKey, fetch),
    clock: clock ?? { now: () => new Date(), zone: 'Europe/Bratislava' },
  });
  return server;
}
