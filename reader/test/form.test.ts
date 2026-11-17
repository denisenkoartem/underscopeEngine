import { describe, expect, it } from 'vitest';
import { compose, composeBody } from '../src/form.js';
import { readRules } from '../src/rules.js';

const read = (fields: Parameters<typeof compose>[0], notes = '') => readRules(compose(fields, notes));

describe('form boxes', () => {
  it('reads short answers in their box', () => {
    const a = read({ title: 'clean, in hand, no lien', mileage: '84k miles, actual', clean: '24500', comps: '9800, 10400 and 11200',
      damage: 'Hood is dented. Everything else is fine.', airbags: 'no', frame: 'No', leaks: 'none' }, 'Runs and drives.');
    expect([a.title_status, a.title_in_hand, a.lien, a.mileage, a.odometer_status]).toEqual(['clean', true, 'none', 84000, 'actual']);
    expect(a.values.clean_wholesale).toBe(24500);
    expect(a.values.salvage_comps).toEqual([9800, 10400, 11200]);
    expect(a.flags).toMatchObject({ airbags_deployed: false, frame_suspected: false, fluid_leak: false });
    expect(a.grades.find((g) => g.part === 'hood')!.grade).toBe('repairable');
    expect(a.run_status).toBe('runs_and_drives');
    expect(a.missing).toEqual([]);
  });
  it('reads yes, and leaves an unsure or unreadable answer unknown', () => {
    expect(read({ airbags: 'yes', frame: 'Yes, bent', leaks: 'yes, coolant' }).flags).toMatchObject({ airbags_deployed: true, frame_suspected: true, fluid_leak: true });
    expect(read({ airbags: 'not sure', frame: 'not checked', leaks: 'not sure' }).flags).toMatchObject({ airbags_deployed: 'unknown', frame_suspected: 'unknown', fluid_leak: 'unknown' });
    expect(read({ airbags: 'banana', frame: 'banana', title: 'banana' })).toMatchObject({ title_status: 'unknown', flags: { airbags_deployed: 'unknown', frame_suspected: 'unknown' } });
    expect(read({ airbags: 'did not deploy', frame: 'bent rail' }).flags).toMatchObject({ airbags_deployed: false, frame_suspected: true });
  });
  it('takes a request body with or without boxes', () => {
    expect(composeBody({ text: 'Clean title.' })).toBe('Clean title.');
    expect(composeBody({ fields: { mileage: '84k' }, text: 'Runs.' })).toBe('Mileage: 84k.\nRuns.');
    expect(composeBody({ fields: { mileage: 84 } })).toBeNull();
    expect(composeBody({ text: 5 })).toBeNull();
  });
});
