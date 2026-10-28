import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, segment, type ApiClient } from './api-client.js';
import {
  dayBounds,
  formatDay,
  formatMoney,
  formatTime,
  localDate,
  resolveDateTime,
  resolveDay,
  type Clock,
} from './dates.js';

/**
 * Six tools, shaped like a receptionist's day rather than like the API.
 *
 * "Is there a free slot for therapy on Monday?" is one question for a person,
 * even though it touches services, therapists and working hours. The tools do
 * that assembly in code so the model does not spend its calls hunting for IDs.
 *
 * Output is plain text for a human. If the model misreads it, the mistake
 * shows up in what it says, where someone can catch it.
 */

export interface ToolContext {
  api: ApiClient;
  clock: Clock;
}

/** What each tool needs from the API key. The API enforces it; this is documentation and a test fixture. */
export const TOOL_SCOPES = {
  find_client: ['clients:read'],
  day_schedule: ['appointments:read'],
  free_slots: ['catalog:read', 'appointments:read'],
  book_client: ['catalog:read', 'appointments:read', 'appointments:write'],
  cancel_appointment: ['appointments:write'],
  unpaid_invoices: ['invoices:read'],
} as const;

/** A problem the model can fix by asking differently. Returned, not thrown at the client. */
class ToolError extends Error {}

/**
 * Runs a tool body and turns every failure into an answer.
 *
 * An API refusal ("This key does not have the invoices:read scope", "That
 * time is not free") is returned as a result with `isError: true` and the
 * API's own sentence, so the model can tell the person what happened and
 * what to try next instead of seeing a protocol error.
 */
async function answer(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await run() }] };
  } catch (error) {
    if (error instanceof ApiError || error instanceof ToolError) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    throw error;
  }
}

interface ClientRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  birthDate: string | null;
}

interface AppointmentRow {
  id: string;
  startsAt: string;
  endsAt: string;
  status: 'booked' | 'cancelled';
  client: { id: string; name: string } | null;
  therapistName: string;
  serviceName: string;
}

interface ServiceRow {
  id: string;
  name: string;
  durationMinutes: number;
}

interface SlotRow {
  startsAt: string;
  therapistId: string;
  therapistName: string;
}

interface InvoiceRow {
  number: string;
  clientName: string;
  dueOn: string;
  totalCents: number;
  outstandingCents: number;
  overdue: boolean;
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

async function findService(api: ApiClient, wanted: string): Promise<ServiceRow> {
  const services = await api.get<ServiceRow[]>('/v1/services');
  const needle = fold(wanted);
  const service =
    services.find((item) => fold(item.name) === needle) ?? services.find((item) => fold(item.name).includes(needle));
  if (!service) {
    throw new ToolError(
      `There is no service called "${wanted}". The clinic offers: ${services.map((item) => item.name).join(', ')}.`,
    );
  }
  return service;
}

function readDay(input: string, clock: Clock): string {
  const day = resolveDay(input, clock);
  if (!day)
    throw new ToolError(`"${input}" is not a day I can read. Use "today", "tomorrow", a weekday or 2026-11-03.`);
  return day;
}

export function registerTools(server: McpServer, { api, clock }: ToolContext): void {
  server.registerTool(
    'find_client',
    {
      title: 'Find a client',
      description:
        'Search clients by name, phone or e-mail. Returns the client ID that booking needs. ' +
        'Two clients can share a name, so confirm with the birth date or phone before booking.',
      inputSchema: { query: z.string().min(2).describe('Name, phone number or e-mail') },
      annotations: { readOnlyHint: true },
    },
    ({ query }) =>
      answer(async () => {
        const result = await api.get<{ items: ClientRow[]; total: number }>('/v1/clients', { search: query });
        if (result.items.length === 0) return `No client matches "${query}".`;

        const lines = result.items.map((client) => {
          const details = [
            client.birthDate && `born ${client.birthDate}`,
            client.phone && `phone ${client.phone}`,
            client.email,
          ].filter(Boolean);
          return `- ${client.firstName} ${client.lastName}${details.length ? `, ${details.join(', ')}` : ''} (ID: ${client.id})`;
        });
        const more =
          result.total > result.items.length
            ? `\n...and ${result.total - result.items.length} more. Narrow the search.`
            : '';
        return `${result.total} found:\n${lines.join('\n')}${more}`;
      }),
  );

  server.registerTool(
    'day_schedule',
    {
      title: 'Schedule for a day',
      description:
        'Who is booked on a given day, with whom and for what. Accepts "today", "tomorrow", a weekday or a date.',
      inputSchema: { day: z.string().default('today').describe('"today", "tomorrow", "Monday" or 2026-11-03') },
      annotations: { readOnlyHint: true },
    },
    ({ day }) =>
      answer(async () => {
        const date = readDay(day, clock);
        const rows = await api.get<AppointmentRow[]>('/v1/appointments', dayBounds(date, clock));
        const booked = rows.filter((row) => row.status === 'booked');
        if (booked.length === 0) return `Nobody is booked on ${formatDay(date, clock)}.`;

        const lines = booked.map(
          (row) =>
            `- ${formatTime(row.startsAt, clock)}-${formatTime(row.endsAt, clock)} ` +
            `${row.client?.name ?? 'no client'}, ${row.serviceName} with ${row.therapistName} (ID: ${row.id})`,
        );
        return `${formatDay(date, clock)}, ${booked.length} booked:\n${lines.join('\n')}`;
      }),
  );

  server.registerTool(
    'free_slots',
    {
      title: 'Free slots',
      description:
        'When a service can be booked over the next days. This does not reserve anything; ' +
        'a slot can be taken by someone else before you book it.',
      inputSchema: {
        service: z.string().min(2).describe('Service name, e.g. "Individual therapy"'),
        from: z.string().default('today').describe('First day to look at'),
        days: z.number().int().min(1).max(30).default(7).describe('How many days ahead'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ service, from, days }) =>
      answer(async () => {
        const firstDay = readDay(from, clock);
        const found = await findService(api, service);
        const slots = await api.get<SlotRow[]>('/v1/availability', {
          serviceId: found.id,
          from: firstDay,
          days: String(days),
        });
        if (slots.length === 0)
          return `No free slots for ${found.name} in ${days} days from ${formatDay(firstDay, clock)}.`;

        const byDay = new Map<string, Map<string, string[]>>();
        for (const slot of slots) {
          const date = localDate(slot.startsAt, clock);
          const times = byDay.get(date) ?? new Map<string, string[]>();
          const time = formatTime(slot.startsAt, clock);
          times.set(time, [...(times.get(time) ?? []), slot.therapistName]);
          byDay.set(date, times);
        }

        const lines = [...byDay].map(([date, times]) => {
          const list = [...times].slice(0, 16).map(([time, names]) => `${time} (${names.join(', ')})`);
          const more = times.size > 16 ? `, and ${times.size - 16} more` : '';
          return `- ${formatDay(date, clock)}: ${list.join(', ')}${more}`;
        });
        return `Free slots for ${found.name} (${found.durationMinutes} min):\n${lines.join('\n')}`;
      }),
  );

  server.registerTool(
    'book_client',
    {
      title: 'Book a client',
      description:
        'Book a client into a free slot. Needs the client ID from find_client, never a name. ' +
        'The therapist is assigned from the free slot; you do not choose one.',
      inputSchema: {
        client_id: z.string().min(1).describe('Client ID from find_client'),
        service: z.string().min(2).describe('Service name'),
        when: z.string().describe('Day and time, e.g. "tomorrow 14:30" or "2026-11-03 09:00"'),
      },
    },
    ({ client_id, service, when }) =>
      answer(async () => {
        const startsAt = resolveDateTime(when, clock);
        if (!startsAt)
          throw new ToolError(
            `"${when}" is not a time I can read. Use something like "tomorrow 14:30" or "2026-11-03 09:00".`,
          );

        const found = await findService(api, service);
        const slots = await api.get<SlotRow[]>('/v1/availability', {
          serviceId: found.id,
          from: localDate(startsAt, clock),
          days: '1',
        });
        const slot = slots.find((candidate) => Date.parse(candidate.startsAt) === Date.parse(startsAt));
        if (!slot) {
          const nearby = [...new Set(slots.map((candidate) => formatTime(candidate.startsAt, clock)))].slice(0, 8);
          throw new ToolError(
            `${found.name} is not free at ${formatTime(startsAt, clock)} on ${formatDay(startsAt, clock)}. ` +
              (nearby.length ? `Free times that day: ${nearby.join(', ')}.` : 'There is nothing free that day.'),
          );
        }

        const booked = await api.post<AppointmentRow>('/v1/appointments', {
          clientId: client_id,
          serviceId: found.id,
          startsAt: slot.startsAt,
          therapistId: slot.therapistId,
        });
        return (
          `Booked ${booked.client?.name ?? client_id} for ${booked.serviceName} on ${formatDay(booked.startsAt, clock)} ` +
          `at ${formatTime(booked.startsAt, clock)} with ${booked.therapistName} (ID: ${booked.id}).`
        );
      }),
  );

  server.registerTool(
    'cancel_appointment',
    {
      title: 'Cancel an appointment',
      description: 'Cancel an appointment by its ID. This cannot be undone, so confirm with the person first.',
      inputSchema: { appointment_id: z.string().min(1).describe('Appointment ID from day_schedule') },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ appointment_id }) =>
      answer(async () => {
        const row = await api.post<AppointmentRow>(`/v1/appointments/${segment(appointment_id)}/cancel`);
        return (
          `Cancelled: ${row.client?.name ?? 'no client'}, ${row.serviceName} on ${formatDay(row.startsAt, clock)} ` +
          `at ${formatTime(row.startsAt, clock)}.`
        );
      }),
  );

  server.registerTool(
    'unpaid_invoices',
    {
      title: 'Unpaid invoices',
      description: 'Invoices that are unpaid or partly paid, overdue ones first.',
      annotations: { readOnlyHint: true },
    },
    () =>
      answer(async () => {
        const rows = await api.get<InvoiceRow[]>('/v1/invoices', { status: 'unpaid' });
        if (rows.length === 0) return 'Every invoice is paid.';

        const sorted = [...rows].sort(
          (left, right) => Number(right.overdue) - Number(left.overdue) || left.dueOn.localeCompare(right.dueOn),
        );
        const lines = sorted.map(
          (row) =>
            `- ${row.number}, ${row.clientName}: ${formatMoney(row.outstandingCents)} of ${formatMoney(row.totalCents)} ` +
            `outstanding, due ${row.dueOn}${row.overdue ? ' (overdue)' : ''}`,
        );
        const total = rows.reduce((sum, row) => sum + row.outstandingCents, 0);
        return `${rows.length} unpaid, ${formatMoney(total)} in total:\n${lines.join('\n')}`;
      }),
  );
}
