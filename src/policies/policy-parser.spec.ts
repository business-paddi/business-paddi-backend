import { isCalendarDate, parseClassNames, parsePolicy } from './policy-parser';

const classes = [
  { id: 'vacation', name: 'Vacation' },
  { id: 'holiday', name: 'Holiday' },
];
const groups = [{ id: 'engineering', name: 'Engineering' }];
const text =
  'Create a vacation policy for employees in engineering for one week during december from the 18th to 25th december';

describe('policy language boundary', () => {
  it('extracts dynamic class names and deduplicates case-insensitively', () => {
    expect(
      parseClassNames('create classes Holiday and Vacation, holiday'),
    ).toEqual(['holiday', 'Vacation']);
    expect(
      parseClassNames('Create classes Work grants and Documents.'),
    ).toEqual(['Work grants', 'Documents']);
  });
  it('rejects empty and malformed class requests', () => {
    expect(() => parseClassNames('create classes Holiday and ')).toThrow();
    expect(() => parseClassNames('delete classes Vacation')).toThrow();
  });
  it('asks for the year instead of inventing one', () => {
    const result = parsePolicy({ text }, classes, groups);
    expect(result.draft).toMatchObject({
      classId: 'vacation',
      groupId: 'engineering',
      durationDays: 7,
    });
    expect(result.questions.map((question) => question.field)).toEqual([
      'year',
    ]);
    expect(typeof result.questions[0].message).toBe('string');
  });
  it('continues the draft using the supplied year', () => {
    const result = parsePolicy({ text, year: 2026 }, classes, groups);
    expect(result.status).toBe('ready');
    expect(result.draft).toMatchObject({
      startsOn: '2026-12-18',
      endsOn: '2026-12-25',
      durationDays: 7,
    });
  });
  it('asks for actual dates when only the month is provided', () => {
    const result = parsePolicy(
      {
        text: 'Create a Vacation policy for employees in Engineering for one week during December',
      },
      classes,
      groups,
    );
    expect(result.questions.map((q) => q.field)).toEqual([
      'startsOn',
      'endsOn',
    ]);
  });
  it('supports names supplied by the business rather than built-in labels', () => {
    const result = parsePolicy(
      {
        text: 'Create a Study breaks policy for employees in Customer Success for two days from 4th to 8th March 2027',
      },
      [{ id: 'study', name: 'Study breaks' }],
      [{ id: 'success', name: 'Customer Success' }],
    );
    expect(result.status).toBe('ready');
    expect(result.draft).toMatchObject({
      classId: 'study',
      groupId: 'success',
      durationDays: 2,
      startsOn: '2027-03-04',
    });
  });
  it('asks for ambiguous or unknown references and rejects foreign IDs', () => {
    const result = parsePolicy(
      { text, classId: 'foreign', groupId: 'foreign', year: 2026 },
      classes,
      groups,
    );
    expect(result.questions.map((q) => q.field)).toEqual(
      expect.arrayContaining(['classId', 'groupId']),
    );
    expect(result.draft.classId).toBeUndefined();
    const ambiguous = parsePolicy(
      { text, year: 2026 },
      [...classes, { id: 'vacations', name: 'Vacations' }],
      groups,
    );
    expect(ambiguous.questions.some((q) => q.field === 'classId')).toBe(true);
  });
  it('never silently drops additional restrictions', () => {
    const result = parsePolicy(
      { text: `${text} 2026 except contractors` },
      classes,
      groups,
    );
    expect(result.status).toBe('needs_input');
    expect(result.questions.some((q) => q.field === 'text')).toBe(true);
  });
  it('supports a complete form without any sentence parsing', () => {
    expect(
      parsePolicy(
        {
          classId: 'holiday',
          groupId: 'engineering',
          startsOn: '2026-12-18',
          endsOn: '2026-12-25',
        },
        classes,
        groups,
      ).status,
    ).toBe('ready');
  });
  it('does not drop restrictions in group wording after a group is selected', () => {
    const result = parsePolicy(
      {
        text: 'Create a Vacation policy for employees in Engineering except contractors',
        groupId: 'engineering',
        startsOn: '2026-12-18',
        endsOn: '2026-12-25',
      },
      classes,
      groups,
    );
    expect(result.status).toBe('needs_input');
    expect(result.questions.some((q) => q.field === 'text')).toBe(true);
  });
  it('validates real dates, leap years, range order and allowance size', () => {
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    const form = {
      classId: 'holiday',
      groupId: 'engineering',
      startsOn: '2026-12-25',
      endsOn: '2026-12-18',
    };
    expect(
      parsePolicy(form, classes, groups).questions.some(
        (q) => q.field === 'endsOn',
      ),
    ).toBe(true);
    expect(
      parsePolicy(
        { ...form, endsOn: '2026-12-25', durationDays: 7 },
        classes,
        groups,
      ).questions.some((q) => q.field === 'durationDays'),
    ).toBe(true);
    expect(
      parsePolicy(
        {
          text: 'Create a Vacation policy for Engineering from 30th to 31st February 2026',
        },
        classes,
        groups,
      ).status,
    ).toBe('needs_input');
  });
  it('asks for form dates for cross-month wording instead of changing its meaning', () => {
    const result = parsePolicy(
      {
        text: 'Create a Vacation policy for Engineering from 30th December to 4th January 2027',
      },
      classes,
      groups,
    );
    expect(result.status).toBe('needs_input');
    expect(result.questions.some((q) => q.field === 'text')).toBe(true);
  });
});
