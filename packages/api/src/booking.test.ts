import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { issueApiKey } from './auth.js';
import { freeSlots } from './availability.js';
import { ROLE_SCOPES } from './scopes.js';
import { createDemoStore } from './seed.js';
import { ConflictError, insertAppointment } from './store.js';

/* Tuesday 3 November 2026, 08:00 in Bratislava (CET, UTC+1). */
const NOW = new Date('2026-11-03T07:00:00Z');

function setup() {
  const store = createDemoStore(NOW);
  const app = createApp({ store, now: () => NOW });
  const { secret } = issueApiKey(store, 'mem_reception', [...ROLE_SCOPES.receptionist]);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, call };
}

describe('availability', () => {
  it('does not offer a slot that overlaps an existing appointment', () => {
    const { store } = setup();
    const [clinic] = store.clinics;
    const service = store.services.find((item) => item.id === 'svc_therapy');
    if (!clinic || !service) throw new Error('seed changed');

    const slots = freeSlots(store, { clinic, service, fromDate: '2026-11-03', days: 1, now: NOW });
    /* Eva is busy 09:00 to 09:45 local, which is 08:00 to 08:45 UTC. */
    const evaAtNine = slots.find(
      (slot) => slot.therapistId === 'mem_owner' && slot.startsAt === '2026-11-03T08:00:00.000Z',
    );
    expect(evaAtNine).toBeUndefined();
    expect(slots.some((slot) => slot.therapistId === 'mem_former')).toBe(false);
    expect(slots[0]?.startsAt).toBe('2026-11-03T07:00:00.000Z');
  });
});

describe('booking', () => {
  it('takes therapist and room from the slot', async () => {
    const { call } = setup();
    const response = await call('POST', '/v1/appointments', {
      clientId: 'cl_004',
      serviceId: 'svc_massage',
      startsAt: '2026-11-03T12:00:00.000Z',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      therapistName: 'Martin Oakes',
      client: { id: 'cl_004', name: 'Zuzana Molnár' },
    });
  });

  it('rejects double booking with a clear error', async () => {
    const { call } = setup();
    const booking = { clientId: 'cl_004', serviceId: 'svc_massage', startsAt: '2026-11-03T12:00:00.000Z' };
    expect((await call('POST', '/v1/appointments', booking)).status).toBe(201);

    const second = await call('POST', '/v1/appointments', { ...booking, clientId: 'cl_002' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      message: 'That time is not free for this service. Ask for free slots and pick one of them.',
    });
  });

  it('the store refuses overlaps even if the engine were bypassed', () => {
    const { store } = setup();
    const existing = store.appointments[0];
    if (!existing) throw new Error('seed changed');
    expect(() => insertAppointment(store, { ...existing, id: 'apt_x', roomId: 'room_2' })).toThrow(ConflictError);
  });

  it('cannot cancel twice', async () => {
    const { call } = setup();
    const created = (await (
      await call('POST', '/v1/appointments', {
        clientId: 'cl_004',
        serviceId: 'svc_massage',
        startsAt: '2026-11-03T12:00:00.000Z',
      })
    ).json()) as { id: string };
    expect((await call('POST', `/v1/appointments/${created.id}/cancel`)).status).toBe(200);
    const again = await call('POST', `/v1/appointments/${created.id}/cancel`);
    expect(again.status).toBe(409);
  });
});
