import 'dotenv/config';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { PolicyInferenceProvider } from '../src/policies/policy-inference.provider';

// Fictional context only. This does not read or write any business database records.
async function main() {
  // Explicit opt-in is required while AI drafting is disabled in the API.
  if (process.env.RUN_DISABLED_POLICY_AI_TEST !== 'true') {
    throw new Error('Policy AI is disabled. Set RUN_DISABLED_POLICY_AI_TEST=true only for an intentional live provider test.');
  }
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!response.ok) {
      const diagnostic = await response.clone().json() as { error?: { code?: unknown; message?: unknown } };
      const key = process.env.OPENROUTER_KEY ?? '';
      const rawMessage = typeof diagnostic.error?.message === 'string' ? diagnostic.error.message : '';
      console.error(JSON.stringify({ status: response.status, message: (key ? rawMessage.split(key).join('[redacted]') : rawMessage).slice(0, 500) }));
    }
    return response;
  };
  const provider = new PolicyInferenceProvider(new ConfigService());
  const refs = { selectedClass: { id: 'vacation', name: 'Vacation' }, groups: [{ id: 'engineering', name: 'Engineering' }, { id: 'hr', name: 'HR' }], employees: [{ id: 'emeka', name: 'Emeka Obi' }], employmentTypes: [{ id: 'full-time', name: 'Full time' }], canViewEmployees: true, employeeDirectoryTruncated: false };
  const text = 'Allow all full-time employees in Engineering a one-week break during December.';
  const first = await provider.extract(text, [], refs);
  console.log(JSON.stringify({ case: 'missing dates', model: first.model, draft: first.extraction }, null, 2));
  assert.deepEqual(first.extraction.groupIds, ['engineering']);
  assert.deepEqual(first.extraction.employmentTypeIds, ['full-time']);
  assert.equal(first.extraction.durationDays, 7);
  assert.equal(first.extraction.startsOn, null);
  assert.equal(first.extraction.endsOn, null);
  assert.ok(first.extraction.missing.length > 0, 'Must ask for dates and year');
  const second = await provider.extract(text, ['The break is December 18 through December 24, 2030.'], refs);
  assert.equal(second.extraction.startsOn, '2030-12-18');
  assert.equal(second.extraction.endsOn, '2030-12-24');
  assert.deepEqual(second.extraction.groupIds, ['engineering']);
  assert.deepEqual(second.extraction.employmentTypeIds, ['full-time']);
  console.log(JSON.stringify({ case: 'follow-up dates', model: second.model, draft: second.extraction }, null, 2));
  const equipment = await provider.extract('Emeka Obi can receive one ThinkPad laptop after completing three months of employment.', [], { ...refs, selectedClass: { id: 'equipment', name: 'Work equipment' } });
  assert.deepEqual(equipment.extraction.employeeIds, ['emeka']);
  assert.ok(equipment.extraction.constraints.some((c) => /three|3/.test(c)), 'Must retain tenure');
  console.log(JSON.stringify({ case: 'named employee and tenure', model: equipment.model, draft: equipment.extraction }, null, 2));
  console.log('PASS: three live free-inference cases; no database records changed.');
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Inference verification failed'); process.exitCode = 1; });
