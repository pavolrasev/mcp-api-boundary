import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FORBIDDEN_SEGMENTS,
  KEY_SCOPES,
  ROLE_SCOPES,
  createApp,
  createDemoStore,
  hasForbiddenSegment,
  issueApiKey,
  type Store,
} from '@demo/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Fetch } from './api-client.js';
import { createServer } from './server.js';
import { TOOL_SCOPES } from './tools.js';

/*
  The real thing, minus Claude: the API over HTTP on a random port, the MCP
  server talking to it with a bearer key, and an MCP client calling tools.
  Tuesday 3 November 2026, 08:00 in Bratislava.
*/
const NOW = new Date('2026-11-03T07:00:00Z');
const clock = { now: () => NOW, zone: 'Europe/Bratislava' };

let store: Store;
let http: ServerType;
let baseUrl = '';
const seen: { path: string; status: number; body: string }[] = [];

const recordingFetch: Fetch = async (input, init) => {
  const response = await fetch(input, init);
  const body = await response.clone().text();
  seen.push({ path: new URL(input).pathname, status: response.status, body });
  return response;
};

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    http = serve({ fetch: (request) => createApp({ store, now: () => NOW }).fetch(request), port: 0 }, () => {
      resolve();
    });
  });
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(() => {
  http.close();
});

beforeEach(() => {
  store = createDemoStore(NOW);
  seen.length = 0;
});

async function connect(memberId = 'mem_reception', scopes = [...ROLE_SCOPES.receptionist]) {
  const { secret } = issueApiKey(
    store,
    memberId,
    scopes.filter((scope) => KEY_SCOPES.includes(scope)),
  );
  const server = createServer({ apiUrl: baseUrl, apiKey: secret, clock, fetch: recordingFetch });
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content.map((part) => part.text).join('\n'), isError: result.isError === true };
  };
  return { client, call, secret };
}

describe('MCP tools against the API', () => {
  it('exposes exactly the six receptionist tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_SCOPES).sort());
  });

  it('finds clients without diacritics and returns their IDs', async () => {
    const { call } = await connect();
    const result = await call('find_client', { query: 'ciern' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Anna Čierna, born 1988-04-12');
    expect(result.text).toContain('(ID: cl_001)');
    expect((await call('find_client', { query: 'anna' })).text).toMatch(/^2 found/);
  });

  it('shows the day in clinic time', async () => {
    const { call } = await connect();
    const result = await call('day_schedule', { day: 'today' });
    expect(result.text).toContain('Tuesday 3 November 2026, 2 booked');
    expect(result.text).toContain('09:00-09:45 Anna Čierna, Individual therapy with Eva Lindqvist (ID: apt_0001)');
  });

  it('books from a free slot and refuses the same slot twice', async () => {
    const { call } = await connect();
    const slots = await call('free_slots', { service: 'massage', from: 'today', days: 1 });
    expect(slots.text).toContain('13:00 (Martin Oakes)');

    const booked = await call('book_client', { client_id: 'cl_004', service: 'Sports massage', when: 'today 13:00' });
    expect(booked).toEqual({
      isError: false,
      text: 'Booked Zuzana Molnár for Sports massage on Tuesday 3 November 2026 at 13:00 with Martin Oakes (ID: apt_0005).',
    });

    const again = await call('book_client', { client_id: 'cl_002', service: 'Sports massage', when: 'today 13:00' });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(
      /^Sports massage is not free at 13:00 on Tuesday 3 November 2026\. Free times that day:/,
    );
  });

  it('passes API errors through as answers', async () => {
    const { call } = await connect();
    const unknownClient = await call('book_client', { client_id: 'cl_999', service: 'massage', when: 'today 13:00' });
    expect(unknownClient).toEqual({
      isError: true,
      text: 'There is no client with that ID. Look the client up first.',
    });

    expect((await call('cancel_appointment', { appointment_id: 'apt_0003' })).text).toContain('Cancelled: Anna Pole');
    expect(await call('cancel_appointment', { appointment_id: 'apt_0003' })).toEqual({
      isError: true,
      text: 'That appointment is already cancelled.',
    });
  });

  it('lists unpaid invoices with money formatted in code', async () => {
    const { call } = await connect();
    const result = await call('unpaid_invoices');
    expect(result.text).toContain('2 unpaid, €75.00 in total');
    expect(result.text).toContain('2026-0101, Anna Čierna: €40.00 of €40.00 outstanding, due 2026-10-18 (overdue)');
  });

  it('cannot do more than the key owner: a therapist key has no invoices', async () => {
    const { call } = await connect('mem_therapist', [...KEY_SCOPES]);
    expect(await call('unpaid_invoices')).toEqual({
      isError: true,
      text: 'This key does not have the invoices:read scope.',
    });
  });

  it('stops working when the key owner is suspended', async () => {
    const { call } = await connect();
    const member = store.members.find((item) => item.id === 'mem_reception');
    if (member) member.status = 'suspended';
    expect(await call('find_client', { query: 'anna' })).toEqual({
      isError: true,
      text: 'This API key is not valid, or its owner is no longer active.',
    });
  });
});

describe('sensitive data stays out of reach', () => {
  it('no tool call, however odd its arguments, gets clinical data', async () => {
    const { call } = await connect('mem_owner', [...KEY_SCOPES]);
    const attempts: [string, Record<string, unknown>][] = [
      ['cancel_appointment', { appointment_id: '../../clients/cl_001/records' }],
      ['cancel_appointment', { appointment_id: 'x/../../../v1/clients/cl_001/records' }],
      ['cancel_appointment', { appointment_id: '%2e%2e/clients/cl_001/photos' }],
      ['find_client', { query: 'records' }],
      ['book_client', { client_id: 'cl_001/records', service: 'massage', when: 'today 13:00' }],
      ['free_slots', { service: '../records' }],
      ['day_schedule', { day: '../../consents' }],
    ];
    for (const [name, args] of attempts) await call(name, args);

    for (const request of seen) {
      expect(request.body).not.toContain('Fictional');
      if (hasForbiddenSegment(request.path)) expect(request.status).toBe(403);
    }
    expect(seen.some((request) => hasForbiddenSegment(request.path))).toBe(true);
  });

  it('no key reaches a sensitive path directly, with every scope a key can hold', async () => {
    const { secret } = await connect('mem_owner', [...KEY_SCOPES]);
    const paths = [...FORBIDDEN_SEGMENTS].flatMap((kind) => [
      `/v1/clients/cl_001/${kind}`,
      `/v1/clients/cl_001/${kind.toUpperCase()}`,
      `/v1/clients/cl_001/%${kind.charCodeAt(0).toString(16)}${kind.slice(1)}`,
      `/v1/clients/cl_001/${kind}/`,
      `/v1/clients/cl_001/${kind}.json`,
      `/v1/${kind}`,
    ]);

    for (const path of paths) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${secret}` } });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.text()).not.toContain('Fictional');
      }
    }
  });
});
