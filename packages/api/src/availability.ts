import { DateTime } from 'luxon';
import type { Appointment, Clinic, Service, Store } from './store.js';

export interface Slot {
  startsAt: string;
  endsAt: string;
  therapistId: string;
  therapistName: string;
  roomId: string;
}

const STEP_MINUTES = 30;

function overlaps(appointment: Appointment, start: number, end: number): boolean {
  return (
    appointment.status !== 'cancelled' &&
    Date.parse(appointment.startsAt) < end &&
    start < Date.parse(appointment.endsAt)
  );
}

/**
 * Free slots for a service, starting on a local date in the clinic's timezone.
 *
 * A slot is a start time plus the therapist and room that are free for the
 * whole service. Booking takes both from here, so the caller never has to
 * pick a therapist itself. Slots in the past are never offered.
 */
export function freeSlots(
  store: Store,
  params: { clinic: Clinic; service: Service; fromDate: string; days: number; now: Date },
): Slot[] {
  const { clinic, service, fromDate, days, now } = params;
  const therapists = store.members.filter(
    (member) => member.status === 'active' && member.serviceIds.includes(service.id),
  );
  const firstDay = DateTime.fromISO(fromDate, { zone: clinic.timezone }).startOf('day');
  if (!firstDay.isValid) return [];

  const slots: Slot[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = firstDay.plus({ days: offset });

    for (const therapist of therapists) {
      const hours = therapist.hours[day.weekday];
      if (!hours) continue;

      const open = DateTime.fromISO(`${day.toISODate()}T${hours[0]}`, { zone: clinic.timezone });
      const close = DateTime.fromISO(`${day.toISODate()}T${hours[1]}`, { zone: clinic.timezone });

      for (
        let start = open;
        start.plus({ minutes: service.durationMinutes }) <= close;
        start = start.plus({ minutes: STEP_MINUTES })
      ) {
        const end = start.plus({ minutes: service.durationMinutes });
        const [startMs, endMs] = [start.toMillis(), end.toMillis()];
        if (startMs < now.getTime()) continue;

        const busy = store.appointments.some(
          (appointment) => appointment.therapistId === therapist.id && overlaps(appointment, startMs, endMs),
        );
        if (busy) continue;

        const room = clinic.rooms.find(
          (candidate) =>
            !store.appointments.some(
              (appointment) => appointment.roomId === candidate.id && overlaps(appointment, startMs, endMs),
            ),
        );
        if (!room) continue;

        slots.push({
          startsAt: start.toUTC().toISO() ?? '',
          endsAt: end.toUTC().toISO() ?? '',
          therapistId: therapist.id,
          therapistName: therapist.name,
          roomId: room.id,
        });
      }
    }
  }

  return slots.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}
