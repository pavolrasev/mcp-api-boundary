import { describe, expect, it } from 'vitest';
import { FORBIDDEN_SEGMENTS, hasForbiddenSegment, scopeForRequest } from './scopes.js';

describe('scopeForRequest', () => {
  it.each([
    ['GET', '/v1/services', 'catalog:read'],
    ['GET', '/v1/clients', 'clients:read'],
    ['POST', '/v1/clients', 'clients:write'],
    ['GET', '/v1/clients/cl_001', 'clients:read'],
    ['GET', '/v1/availability', 'appointments:read'],
    ['post', '/v1/appointments', 'appointments:write'],
    ['POST', '/v1/appointments/apt_0001/cancel', 'appointments:write'],
    ['GET', '/v1/invoices', 'invoices:read'],
    ['GET', '/v1/clients/cl_001/records', 'clinical:read'],
  ])('%s %s needs %s', (method, path, scope) => {
    expect(scopeForRequest(method, path)).toBe(scope);
  });

  it.each([
    ['DELETE', '/v1/clients/cl_001'],
    ['PUT', '/v1/appointments'],
    ['HEAD', '/v1/clients'],
    ['GET', '/v1/admin'],
    ['GET', '/v1/clients/'],
    ['GET', '/v1/clients/cl_001/'],
    ['GET', '/v1//clients'],
    ['GET', '/v1/clients/cl%2F001'],
    ['GET', '/v1/appointments/apt_0001/cancel'],
    ['POST', '/v1/invoices'],
    ['GET', '/v1/clients/cl_001/billing'],
  ])('%s %s is unmapped, so it gets no scope', (method, path) => {
    expect(scopeForRequest(method, path)).toBeNull();
  });
});

describe('hasForbiddenSegment', () => {
  it.each([...FORBIDDEN_SEGMENTS])('refuses /v1/clients/cl_001/%s', (segment) => {
    expect(hasForbiddenSegment(`/v1/clients/cl_001/${segment}`)).toBe(true);
  });

  it.each([
    '/v1/clients/cl_001/RECORDS',
    '/v1/clients/cl_001/%72ecords',
    '/v1/clients/cl_001%2Fphotos',
    '/v1/clients/cl_001/records/',
    '/v1/clients/cl_001/records.json',
    '/v1/clients/cl_001/notes;v=2',
    '/v1/records/cl_001',
    '/v1/clients/%E0%A4%A',
  ])('also refuses %s', (path) => {
    expect(hasForbiddenSegment(path)).toBe(true);
  });

  it.each(['/v1/clients', '/v1/appointments', '/v1/clients/cl_001', '/v1/clients/recordsmith'])(
    'lets %s through to the scope check',
    (path) => {
      expect(hasForbiddenSegment(path)).toBe(false);
    },
  );
});
