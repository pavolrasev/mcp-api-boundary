import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

/* stdout belongs to the protocol. Anything for humans goes to stderr. */
const apiKey = process.env['CLINIC_API_KEY'];
if (!apiKey) {
  console.error('Set CLINIC_API_KEY to an API key from the clinic API.');
  process.exit(1);
}

const server = createServer({
  apiUrl: process.env['CLINIC_API_URL'] ?? 'http://localhost:8787',
  apiKey,
  clock: { now: () => new Date(), zone: process.env['CLINIC_TIMEZONE'] ?? 'Europe/Bratislava' },
});

await server.connect(new StdioServerTransport());
console.error('clinic-reception MCP server running on stdio');
