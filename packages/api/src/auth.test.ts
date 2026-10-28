import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { authenticate, hashSecret, issueApiKey, issueSession } from './auth.js';
import { KEY_SCOPES } from './scopes.js';
import { createDemoStore } from './seed.js';

const NOW = new Date('2026-11-03T07:00:00Z');

function setup() {
  const store = createDemoStore(NOW);
  const app = createApp({ store, now: () => NOW });
  const get = (path: string, secret: string) => app.request(path, { headers: { authorization: `Bearer ${secret}` } });
  return { store, app, get };
}

describe('API keys', () => {
  it('stores only the SHA-256 hash of the secret', () => {
    const { store } = setup();
    const { secret } = issueApiKey(store, 'mem_reception', ['clients:read']);
    const stored = store.apiKeys.at(-1);
    expect(stored?.hash).toBe(hashSecret(secret));
    expect(JSON.stringify(store)).not.toContain(secret);
  });

  it('caps granted scopes at what the owner role allows', () => {
    const { store } = setup();
    const { secret } = issueApiKey(store, 'mem_therapist', ['clients:read', 'invoices:read', 'clients:write']);
    const principal = authenticate(store, secret);
    expect([...(principal?.scopes ?? [])]).toEqual(['clients:read']);
  });

  it('shrinks when the owner is demoted', async () => {
    const { store, get } = setup();
    const { secret } = issueApiKey(store, 'mem_reception', ['invoices:read']);
    expect((await get('/v1/invoices', secret)).status).toBe(200);

    const member = store.members.find((item) => item.id === 'mem_reception');
    if (member) member.role = 'therapist';
    const response = await get('/v1/invoices', secret);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'This key does not have the invoices:read scope.' });
  });

  it('stops working when its owner is suspended', async () => {
    const { store, get } = setup();
    const { secret } = issueApiKey(store, 'mem_therapist', ['clients:read']);
    expect((await get('/v1/clients', secret)).status).toBe(200);

    const member = store.members.find((item) => item.id === 'mem_therapist');
    if (member) member.status = 'suspended';
    expect(authenticate(store, secret)).toBeNull();
    const response = await get('/v1/clients', secret);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('refuses to grant clinical scopes to a key', () => {
    const { store } = setup();
    expect(() => issueApiKey(store, 'mem_owner', ['clinical:read'])).toThrow(/cannot be granted/);
  });

  it('answers 401 without a key and 403 for an unmapped route', async () => {
    const { store, app } = setup();
    expect((await app.request('/v1/clients')).status).toBe(401);
    const { secret } = issueApiKey(store, 'mem_owner', [...KEY_SCOPES]);
    const response = await app.request('/v1/clients/cl_001', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(403);
  });
});

describe('sensitive paths', () => {
  const kinds = ['records', 'notes', 'photos', 'attachments', 'consents', 'surveys'];

  it('are refused for a key with every grantable scope, owned by the owner', async () => {
    const { store, get } = setup();
    const { secret } = issueApiKey(store, 'mem_owner', [...KEY_SCOPES]);
    for (const kind of kinds) {
      const response = await get(`/v1/clients/cl_001/${kind}`, secret);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        message: 'Clinical data is never available to API keys or assistants.',
      });
    }
  });

  it('are refused even if a key somehow held clinical:read', async () => {
    const { store, get } = setup();
    const { secret } = issueApiKey(store, 'mem_owner', ['clients:read']);
    const key = store.apiKeys.at(-1);
    key?.scopes.push('clinical:read');
    expect((await get('/v1/clients/cl_001/records', secret)).status).toBe(403);
  });

  it('stay readable for a signed-in therapist in the app', async () => {
    const { store, get } = setup();
    const session = issueSession(store, 'mem_owner');
    const response = await get('/v1/clients/cl_001/records', session);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(1);
  });
});
