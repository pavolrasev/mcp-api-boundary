import type { Role, Scope } from './scopes.js';

/**
 * The in-memory store. A real system has a database here; the rules around
 * it are the point of this repository, not the storage.
 */

export interface Clinic {
  id: string;
  name: string;
  timezone: string;
  rooms: { id: string; name: string }[];
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

/** Local working hours per ISO weekday (1 = Monday), e.g. `{ 1: ['08:00', '16:00'] }`. */
export type WorkingHours = Partial<Record<number, readonly [string, string]>>;

export interface Member {
  id: string;
  name: string;
  role: Role;
  status: 'active' | 'suspended';
  /** Services this person treats. Empty for people who do not see clients. */
  serviceIds: string[];
  hours: WorkingHours;
}

export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  birthDate: string | null;
}

export interface Appointment {
  id: string;
  clinicId: string;
  clientId: string;
  serviceId: string;
  therapistId: string;
  roomId: string;
  startsAt: string;
  endsAt: string;
  status: 'booked' | 'cancelled';
}

export interface Invoice {
  id: string;
  number: string;
  clientId: string;
  issuedOn: string;
  dueOn: string;
  totalCents: number;
  paidCents: number;
}

export type ClinicalKind = 'records' | 'notes' | 'photos' | 'attachments' | 'consents' | 'surveys';

/** Data that must never reach a chat window. */
export interface ClinicalItem {
  clientId: string;
  kind: ClinicalKind;
  text: string;
}

export interface ApiKey {
  id: string;
  memberId: string;
  label: string;
  /** SHA-256 of the secret, hex. The secret itself is shown once and never stored. */
  hash: string;
  scopes: Scope[];
  revoked: boolean;
}

export interface Session {
  memberId: string;
  hash: string;
}

export interface Store {
  clinics: Clinic[];
  services: Service[];
  members: Member[];
  clients: Client[];
  appointments: Appointment[];
  invoices: Invoice[];
  clinical: ClinicalItem[];
  apiKeys: ApiKey[];
  sessions: Session[];
}

export function emptyStore(): Store {
  return {
    clinics: [],
    services: [],
    members: [],
    clients: [],
    appointments: [],
    invoices: [],
    clinical: [],
    apiKeys: [],
    sessions: [],
  };
}

export class ConflictError extends Error {}

/**
 * Inserts an appointment, refusing any overlap for the same therapist or room.
 *
 * This is the in-memory stand-in for an exclusion constraint in the database.
 * The availability engine should never offer an overlapping slot, but this is
 * the check that holds when two people book the same minute.
 */
export function insertAppointment(store: Store, appointment: Appointment): Appointment {
  const start = Date.parse(appointment.startsAt);
  const end = Date.parse(appointment.endsAt);

  for (const other of store.appointments) {
    if (other.status === 'cancelled') continue;
    const overlaps = Date.parse(other.startsAt) < end && start < Date.parse(other.endsAt);
    if (!overlaps) continue;
    if (other.therapistId === appointment.therapistId) {
      throw new ConflictError('The therapist already has an appointment at that time.');
    }
    if (other.roomId === appointment.roomId) {
      throw new ConflictError('The room is already taken at that time.');
    }
  }

  store.appointments.push(appointment);
  return appointment;
}
