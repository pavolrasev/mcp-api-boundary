import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { authenticate, type Principal } from './auth.js';
import { freeSlots } from './availability.js';
import { hasForbiddenSegment, scopeForRequest } from './scopes.js';
import { ConflictError, insertAppointment, type Appointment, type Store } from './store.js';

type Env = { Variables: { principal: Principal } };
type Status = 400 | 401 | 403 | 404 | 409;

export interface AppOptions {
  store: Store;
  /** Injected so tests and the demo seed agree on what "now" is. */
  now?: () => Date;
}

/* Every error is a sentence a person (or a model) can act on. */
function fail(status: Status, message: string): Response {
  const headers: Record<string, string> = status === 401 ? { 'WWW-Authenticate': 'Bearer realm="clinic-api"' } : {};
  return Response.json({ error: status, message }, { status, headers });
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function createApp({ store, now = () => new Date() }: AppOptions) {
  const app = new Hono<Env>();

  app.get('/health', (c) => c.json({ ok: true }));

  /*
    The boundary. Order matters:
    1. who is calling (401 if nobody we know),
    2. sensitive paths, refused for keys before any scope is looked at,
    3. the scope this method and path need (403 if the route is not mapped),
    4. whether the caller holds it.
  */
  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) return fail(401, 'Send an API key as a bearer token.');

    const principal = authenticate(store, match[1]);
    if (!principal) return fail(401, 'This API key is not valid, or its owner is no longer active.');

    const path = new URL(c.req.url).pathname;
    if (principal.kind === 'api_key' && hasForbiddenSegment(path)) {
      return fail(403, 'Clinical data is never available to API keys or assistants.');
    }

    const scope = scopeForRequest(c.req.method, path);
    if (!scope) return fail(403, 'This endpoint is not open to API calls.');

    if (!principal.scopes.has(scope)) {
      return fail(403, `This key does not have the ${scope} scope.`);
    }

    c.set('principal', principal);
    await next();
    return undefined;
  });

  const clinicFor = (id: string | undefined) =>
    id ? store.clinics.find((clinic) => clinic.id === id) : store.clinics[0];

  const appointmentView = (appointment: Appointment) => {
    const client = store.clients.find((item) => item.id === appointment.clientId);
    return {
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      client: client ? { id: client.id, name: `${client.firstName} ${client.lastName}` } : null,
      therapistName: store.members.find((item) => item.id === appointment.therapistId)?.name ?? 'Unknown',
      serviceName: store.services.find((item) => item.id === appointment.serviceId)?.name ?? 'Unknown',
    };
  };

  app.get('/v1/clinics', (c) => c.json(store.clinics));
  app.get('/v1/services', (c) => c.json(store.services));
  app.get('/v1/team', (c) => c.json(store.members.map(({ id, name, role, status }) => ({ id, name, role, status }))));

  app.get('/v1/clients', (c) => {
    const query = fold(c.req.query('search') ?? '').trim();
    const digits = query.replace(/\D/g, '');
    const matches = store.clients.filter((client) => {
      const name = fold(`${client.firstName} ${client.lastName}`);
      return (
        query === '' ||
        name.includes(query) ||
        fold(`${client.lastName} ${client.firstName}`).includes(query) ||
        (client.email?.toLowerCase().includes(query) ?? false) ||
        (digits.length >= 4 && (client.phone?.replace(/\D/g, '').includes(digits) ?? false))
      );
    });
    return c.json({ items: matches.slice(0, 10), total: matches.length });
  });

  app.get('/v1/clients/:id', (c) => {
    const client = store.clients.find((item) => item.id === c.req.param('id'));
    return client ? c.json(client) : fail(404, `There is no client with ID ${c.req.param('id')}.`);
  });

  /* Only a signed-in therapist or owner ever gets here; keys are stopped above. */
  app.get('/v1/clients/:id/:kind{records|notes|photos|attachments|consents|surveys}', (c) =>
    c.json(store.clinical.filter((item) => item.clientId === c.req.param('id') && item.kind === c.req.param('kind'))),
  );

  app.get('/v1/availability', (c) => {
    const clinic = clinicFor(c.req.query('clinicId'));
    const service = store.services.find((item) => item.id === c.req.query('serviceId'));
    const from = c.req.query('from') ?? '';
    const days = Number(c.req.query('days') ?? '1');
    if (!clinic) return fail(404, 'There is no such clinic.');
    if (!service) return fail(400, 'Say which service: serviceId is missing or unknown.');
    if (!DateTime.fromISO(from).isValid) return fail(400, 'from must be a date like 2026-11-03.');
    if (!Number.isInteger(days) || days < 1 || days > 30) return fail(400, 'days must be between 1 and 30.');

    return c.json(freeSlots(store, { clinic, service, fromDate: from, days, now: now() }));
  });

  app.get('/v1/appointments', (c) => {
    const from = Date.parse(c.req.query('from') ?? '');
    const to = Date.parse(c.req.query('to') ?? '');
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return fail(400, 'from and to must be ISO timestamps.');
    }
    const rows = store.appointments
      .filter((item) => Date.parse(item.startsAt) >= from && Date.parse(item.startsAt) < to)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    return c.json(rows.map(appointmentView));
  });

  app.post('/v1/appointments', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const clinic = clinicFor(typeof body['clinicId'] === 'string' ? body['clinicId'] : undefined);
    const client = store.clients.find((item) => item.id === body['clientId']);
    const service = store.services.find((item) => item.id === body['serviceId']);
    const startsAt = typeof body['startsAt'] === 'string' ? DateTime.fromISO(body['startsAt']) : null;

    if (!clinic) return fail(404, 'There is no such clinic.');
    if (!client) return fail(404, 'There is no client with that ID. Look the client up first.');
    if (!service) return fail(404, 'There is no service with that ID.');
    if (!startsAt?.isValid) return fail(400, 'startsAt must be an ISO timestamp.');

    /* The therapist and room come from the availability engine, never from the caller's guess. */
    const localDate = startsAt.setZone(clinic.timezone).toISODate() ?? '';
    const slot = freeSlots(store, { clinic, service, fromDate: localDate, days: 1, now: now() }).find(
      (candidate) =>
        Date.parse(candidate.startsAt) === startsAt.toMillis() &&
        (body['therapistId'] === undefined || candidate.therapistId === body['therapistId']),
    );
    if (!slot) {
      return fail(409, 'That time is not free for this service. Ask for free slots and pick one of them.');
    }

    try {
      const appointment = insertAppointment(store, {
        id: `apt_${String(store.appointments.length + 1).padStart(4, '0')}`,
        clinicId: clinic.id,
        clientId: client.id,
        serviceId: service.id,
        therapistId: slot.therapistId,
        roomId: slot.roomId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: 'booked',
      });
      return c.json(appointmentView(appointment), 201);
    } catch (error) {
      if (error instanceof ConflictError) return fail(409, error.message);
      throw error;
    }
  });

  app.post('/v1/appointments/:id/cancel', (c) => {
    const appointment = store.appointments.find((item) => item.id === c.req.param('id'));
    if (!appointment) return fail(404, `There is no appointment with ID ${c.req.param('id')}.`);
    if (appointment.status === 'cancelled') return fail(409, 'That appointment is already cancelled.');
    if (Date.parse(appointment.startsAt) < now().getTime()) {
      return fail(409, 'That appointment has already started or is in the past, so it cannot be cancelled.');
    }
    appointment.status = 'cancelled';
    return c.json(appointmentView(appointment));
  });

  app.get('/v1/invoices', (c) => {
    const unpaidOnly = c.req.query('status') === 'unpaid';
    const timezone = store.clinics[0]?.timezone ?? 'UTC';
    const today = DateTime.fromJSDate(now(), { zone: timezone }).toISODate() ?? '';
    const rows = store.invoices
      .filter((invoice) => !unpaidOnly || invoice.paidCents < invoice.totalCents)
      .map((invoice) => {
        const client = store.clients.find((item) => item.id === invoice.clientId);
        return {
          ...invoice,
          clientName: client ? `${client.firstName} ${client.lastName}` : 'Unknown',
          outstandingCents: invoice.totalCents - invoice.paidCents,
          overdue: invoice.paidCents < invoice.totalCents && invoice.dueOn < today,
        };
      });
    return c.json(rows);
  });

  app.notFound(() => fail(404, 'There is nothing at this address.'));

  return app;
}
