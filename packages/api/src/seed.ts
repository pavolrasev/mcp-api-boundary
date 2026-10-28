import { DateTime } from 'luxon';
import { emptyStore, insertAppointment, type Store, type WorkingHours } from './store.js';

/* Monday to Friday, 08:00 to 16:00 local time. */
const WEEKDAYS: WorkingHours = {
  1: ['08:00', '16:00'],
  2: ['08:00', '16:00'],
  3: ['08:00', '16:00'],
  4: ['08:00', '16:00'],
  5: ['08:00', '16:00'],
};

export const TIMEZONE = 'Europe/Bratislava';

/**
 * A small fictional practice. Every name, phone number and note below is
 * made up. Appointments are placed relative to `now`, so the demo always has
 * something on today's and tomorrow's schedule.
 */
export function createDemoStore(now: Date = new Date()): Store {
  const store = emptyStore();

  store.clinics.push({
    id: 'clinic_main',
    name: 'Riverside Physio',
    timezone: TIMEZONE,
    rooms: [
      { id: 'room_1', name: 'Room 1' },
      { id: 'room_2', name: 'Room 2' },
    ],
  });

  store.services.push(
    { id: 'svc_assessment', name: 'Initial assessment', durationMinutes: 60, priceCents: 5500 },
    { id: 'svc_therapy', name: 'Individual therapy', durationMinutes: 45, priceCents: 4000 },
    { id: 'svc_massage', name: 'Sports massage', durationMinutes: 30, priceCents: 3000 },
  );

  store.members.push(
    {
      id: 'mem_owner',
      name: 'Eva Lindqvist',
      role: 'owner',
      status: 'active',
      serviceIds: ['svc_assessment', 'svc_therapy'],
      hours: WEEKDAYS,
    },
    {
      id: 'mem_therapist',
      name: 'Martin Oakes',
      role: 'therapist',
      status: 'active',
      serviceIds: ['svc_therapy', 'svc_massage'],
      hours: WEEKDAYS,
    },
    { id: 'mem_reception', name: 'Lucia Moravec', role: 'receptionist', status: 'active', serviceIds: [], hours: {} },
    {
      id: 'mem_former',
      name: 'Peter Holm',
      role: 'therapist',
      status: 'suspended',
      serviceIds: ['svc_therapy'],
      hours: WEEKDAYS,
    },
  );

  store.clients.push(
    {
      id: 'cl_001',
      firstName: 'Anna',
      lastName: 'Čierna',
      phone: '+421 900 111 201',
      email: 'anna.c@example.com',
      birthDate: '1988-04-12',
    },
    {
      id: 'cl_002',
      firstName: 'Anna',
      lastName: 'Pole',
      phone: '+421 900 111 202',
      email: null,
      birthDate: '1975-09-30',
    },
    {
      id: 'cl_003',
      firstName: 'Tomas',
      lastName: 'Varga',
      phone: '+421 900 111 203',
      email: 'tvarga@example.com',
      birthDate: null,
    },
    {
      id: 'cl_004',
      firstName: 'Zuzana',
      lastName: 'Molnár',
      phone: null,
      email: 'zuzana@example.com',
      birthDate: '1992-01-05',
    },
    {
      id: 'cl_005',
      firstName: 'Michal',
      lastName: 'Brook',
      phone: '+421 900 111 205',
      email: null,
      birthDate: '2001-07-19',
    },
  );

  const today = DateTime.fromJSDate(now, { zone: TIMEZONE }).startOf('day');
  const at = (dayOffset: number, time: string, minutes: number) => {
    const [hour = 0, minute = 0] = time.split(':').map(Number);
    const start = today.plus({ days: dayOffset }).set({ hour, minute });
    return {
      startsAt: start.toUTC().toISO() ?? '',
      endsAt: start.plus({ minutes }).toUTC().toISO() ?? '',
    };
  };

  const seed = [
    {
      client: 'cl_001',
      service: 'svc_therapy',
      therapist: 'mem_owner',
      room: 'room_1',
      day: 0,
      time: '09:00',
      minutes: 45,
    },
    {
      client: 'cl_003',
      service: 'svc_massage',
      therapist: 'mem_therapist',
      room: 'room_2',
      day: 0,
      time: '10:00',
      minutes: 30,
    },
    {
      client: 'cl_002',
      service: 'svc_assessment',
      therapist: 'mem_owner',
      room: 'room_1',
      day: 1,
      time: '08:00',
      minutes: 60,
    },
    {
      client: 'cl_005',
      service: 'svc_therapy',
      therapist: 'mem_therapist',
      room: 'room_2',
      day: 1,
      time: '13:00',
      minutes: 45,
    },
  ];
  seed.forEach((row, index) => {
    insertAppointment(store, {
      id: `apt_${String(index + 1).padStart(4, '0')}`,
      clinicId: 'clinic_main',
      clientId: row.client,
      serviceId: row.service,
      therapistId: row.therapist,
      roomId: row.room,
      ...at(row.day, row.time, row.minutes),
      status: 'booked',
    });
  });

  const date = (offset: number) => today.plus({ days: offset }).toISODate() ?? '';
  store.invoices.push(
    {
      id: 'inv_1',
      number: '2026-0101',
      clientId: 'cl_001',
      issuedOn: date(-30),
      dueOn: date(-16),
      totalCents: 4000,
      paidCents: 0,
    },
    {
      id: 'inv_2',
      number: '2026-0102',
      clientId: 'cl_003',
      issuedOn: date(-5),
      dueOn: date(9),
      totalCents: 5500,
      paidCents: 2000,
    },
    {
      id: 'inv_3',
      number: '2026-0103',
      clientId: 'cl_004',
      issuedOn: date(-10),
      dueOn: date(4),
      totalCents: 3000,
      paidCents: 3000,
    },
  );

  store.clinical.push(
    { clientId: 'cl_001', kind: 'records', text: 'Fictional note: right knee, week 3 after arthroscopy.' },
    { clientId: 'cl_001', kind: 'consents', text: 'Fictional consent: treatment plan signed.' },
    { clientId: 'cl_003', kind: 'surveys', text: 'Fictional survey: pain 4/10.' },
  );

  return store;
}
