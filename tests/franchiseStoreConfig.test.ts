import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { Franchise } from '../src/models/Franchise.js';
import { User } from '../src/models/User.js';
import { WeeklyRoster } from '../src/models/WeeklyRoster.js';
import { otherStoreId, queryResult, setupFranchiseApi, storeId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi();

describe('franchise store config API', () => {
  it('restricts branding reads to stores assigned to the franchise admin', async () => {
    const denied = await call('GET', `/stores/branding?storeId=${otherStoreId}`);
    assert.equal(denied.status, 403);
    mock.method(Franchise, 'findById', () => queryResult({ name: 'North', logo: { fileId: 'logo-id' } }));
    const allowed = await call('GET', `/stores/branding?storeId=${storeId}`);
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { store: { name: 'North', hasLogo: true } });
  });

  it('validates and updates store branding', async () => {
    const invalid = await call('PUT', '/stores/branding', { storeId: String(storeId), name: '  ' });
    assert.equal(invalid.status, 400);
    mock.method(Franchise, 'findOneAndUpdate', () => queryResult({ name: 'Updated' }));
    const response = await call('PUT', '/stores/branding', { storeId: String(storeId), name: ' Updated ' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Store name updated.', store: { name: 'Updated' } });
  });

  it('returns configured cycle ranges and validates cycle updates', async () => {
    mock.method(Franchise, 'findById', () => queryResult({ salaryCycleType: 'custom', salaryCycleStartDay: 21, salaryCycleEndDay: 20, salaryCycleConfiguredAt: new Date() }));
    const cycle = await call('GET', `/stores/cycle?storeId=${storeId}&period=2026-02`);
    assert.equal(cycle.status, 200);
    assert.deepEqual((await cycle.json() as { cycle: Record<string, unknown> }).cycle, {
      configured: true, type: 'custom', startDay: 21, endDay: 20, from: '2026-01-21', to: '2026-02-20',
    });
    const invalid = await call('PUT', '/stores/cycle', { storeId: String(storeId), cycleType: 'custom', startDay: 29 });
    assert.equal(invalid.status, 400);
    mock.method(Franchise, 'findOneAndUpdate', () => queryResult({ salaryCycleStartDay: 1, salaryCycleEndDay: 31 }));
    const saved = await call('PUT', '/stores/cycle', { storeId: String(storeId), cycleType: 'calendar_month' });
    assert.equal(saved.status, 200);
  });

  it('returns configured position and shift choices', async () => {
    mock.method(Franchise, 'findById', (id: unknown) => queryResult(String(id) === String(storeId) ? { positions: ['Manager'], shifts: [{ id: 'day', name: 'Day', startTime: '09:00', endTime: '17:00' }] } : null));
    const positions = await call('GET', `/stores/positions?storeId=${storeId}`);
    assert.deepEqual(await positions.json(), { positions: ['Manager'] });
    const shifts = await call('GET', `/stores/shifts?storeId=${storeId}`);
    assert.deepEqual(await shifts.json(), { shifts: [{ id: 'day', name: 'Day', startTime: '09:00', endTime: '17:00' }] });
  });

  it('validates position and shift payloads before writes', async () => {
    const positions = await call('PUT', '/stores/positions', { storeId: String(storeId), positions: ['SM', ' sm '] });
    assert.equal(positions.status, 409);
    const shifts = await call('PUT', '/stores/shifts', { storeId: String(storeId), shifts: [{ id: 'a', name: 'Day', startTime: '25:00', endTime: '17:00' }] });
    assert.equal(shifts.status, 400);
  });

  it('prevents removing positions and shifts still used by store records', async () => {
    mock.method(Franchise, 'findById', () => queryResult({ positions: ['SM'], shifts: [{ id: 'old', name: 'Old', startTime: '09:00', endTime: '17:00' }], save: async () => undefined }));
    mock.method(User, 'exists', async () => ({ _id: 'employee' }));
    const positions = await call('PUT', '/stores/positions', { storeId: String(storeId), positions: ['GSA'] });
    assert.equal(positions.status, 409);
    mock.method(WeeklyRoster, 'exists', async () => ({ _id: 'roster' }));
    const shifts = await call('PUT', '/stores/shifts', { storeId: String(storeId), shifts: [] });
    assert.equal(shifts.status, 409);
  });
});
