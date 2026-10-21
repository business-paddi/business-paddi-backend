export type Reference = { id: string; name: string };
export type PolicyInput = {
  text?: string;
  name?: string;
  classId?: string;
  groupId?: string;
  durationDays?: number;
  startsOn?: string;
  endsOn?: string;
  year?: number;
};
export type Question = {
  field: string;
  message: string;
  options?: Reference[];
};
export const nameKey = (name: string) =>
  name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

export function parseClassNames(text: string): string[] {
  const match = text
    .trim()
    .match(/^create\s+(?:policy\s+)?class(?:es)?\s+(.+?)[.!]?$/is);
  if (!match) throw new Error('Try: create classes Holiday and Vacation.');
  if (/\band\s*$/i.test(match[1]))
    throw new Error('Please provide a class name after “and”.');
  const names = match[1]
    .split(/\s+and\s+|[,;\n]+|\s*&\s*/i)
    .map((n) => n.trim());
  return validateClassNames(names);
}

export function validateClassNames(names: string[]) {
  if (!names.length || names.length > 20)
    throw new Error('Provide between 1 and 20 class names.');
  const unique = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (
      !name ||
      name.length > 100 ||
      !/^[\p{L}\p{N}][\p{L}\p{N} '\u2019()/-]*$/u.test(name)
    )
      throw new Error(
        'Class names must be 1–100 characters and contain letters, numbers, spaces, apostrophes, parentheses, slashes or hyphens.',
      );
    unique.set(nameKey(name), name);
  }
  return [...unique.values()];
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const numbers: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const singular = (value: string) => nameKey(value).replace(/s$/, '');

// Intentionally bounded grammar. Unknown clauses block creation instead of being ignored.
// References always come from the current business; no hardcoded class/group names.
export function parsePolicy(
  input: PolicyInput,
  classes: Reference[],
  groups: Reference[],
) {
  const questions: Question[] = [];
  const draft: PolicyInput = { ...input };
  let className: string | undefined;
  let groupName: string | undefined;
  let dateMonth: string | undefined;
  let startDay: number | undefined;
  let endDay: number | undefined;
  let parsedYear: number | undefined;
  if (input.text) {
    const sentence = input.text.trim().replace(/[.!]$/, '');
    const base = sentence.match(
      /^(?:create\s+(?:a\s+)?)?(.+?)\s+policy\s+for\s+(?:employees\s+in\s+)?(.+?)(?=\s+for\s+|\s+during\s+|\s+from\s+|$)(.*)$/i,
    );
    let remainder = base?.[3].trim() ?? sentence;
    if (base) {
      className = base[1].trim();
      groupName = base[2].trim();
      const duration = remainder.match(
        /^for\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(days?|weeks?)\b\s*/i,
      );
      if (duration) {
        const quantity =
          numbers[duration[1].toLowerCase()] ?? Number(duration[1]);
        draft.durationDays ??= quantity * (/^week/i.test(duration[2]) ? 7 : 1);
        remainder = remainder.slice(duration[0].length).trim();
      }
      const during = remainder.match(/^during\s+([a-z]+)(?:\s+(\d{4}))?\b\s*/i);
      let duringMonth: string | undefined;
      if (during && months.includes(during[1].toLowerCase())) {
        duringMonth = during[1].toLowerCase();
        parsedYear = during[2] ? Number(during[2]) : undefined;
        remainder = remainder.slice(during[0].length).trim();
      }
      const dates = remainder.match(
        /^from\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+([a-z]+))?\s+to\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+([a-z]+))?(?:\s+(\d{4}))?$/i,
      );
      if (dates) {
        const firstMonth = dates[2]?.toLowerCase();
        const lastMonth = dates[4]?.toLowerCase();
        dateMonth = lastMonth ?? firstMonth ?? duringMonth;
        // Cross-month ranges use the form in v1; never silently reinterpret them.
        if (
          dateMonth &&
          months.includes(dateMonth) &&
          (!firstMonth || firstMonth === dateMonth) &&
          (!duringMonth || duringMonth === dateMonth)
        ) {
          startDay = Number(dates[1]);
          endDay = Number(dates[3]);
          if (dates[5]) parsedYear = Number(dates[5]);
          remainder = '';
        }
      }
    }
    if (!base || remainder)
      questions.push({
        field: 'text',
        message:
          'I could not understand the complete request. Try “Create a Vacation policy for employees in Engineering for one week during December from 18th to 25th December 2026”, or use the form. Extra restrictions are not supported yet.',
      });
  }
  const resolve = (
    field: 'classId' | 'groupId',
    requested: string | undefined,
    choices: Reference[],
  ) => {
    const supplied = input[field];
    const matches = supplied
      ? choices.filter((r) => r.id === supplied)
      : choices.filter(
          (r) => requested && singular(r.name) === singular(requested),
        );
    if (matches.length === 1) draft[field] = matches[0].id;
    else {
      delete draft[field];
      questions.push({
        field,
        message:
          field === 'classId'
            ? 'Which class does this policy belong to?'
            : 'Which employee group should this policy apply to?',
        options: choices,
      });
    }
  };
  resolve('classId', className, classes);
  resolve('groupId', groupName, groups);
  // A follow-up selection must not accidentally discard a restriction embedded
  // in an unresolved label, e.g. "Engineering except contractors".
  const restrictedLabel = (
    [
      [className, classes],
      [groupName, groups],
    ] as const
  ).some(
    ([label, choices]) =>
      label &&
      !choices.some((choice) => singular(choice.name) === singular(label)) &&
      /\b(?:except|excluding|only|tenure|full[- ]time|part[- ]time|after|before|unless|minimum|maximum)\b/i.test(
        label,
      ),
  );
  if (
    restrictedLabel &&
    !questions.some((question) => question.field === 'text')
  ) {
    questions.push({
      field: 'text',
      message:
        'This request includes a restriction that this version cannot represent. Please edit the request or use the form for a policy without that restriction.',
    });
  }
  const year = input.year ?? parsedYear;
  if (
    dateMonth &&
    startDay !== undefined &&
    endDay !== undefined &&
    (!draft.startsOn || !draft.endsOn)
  ) {
    if (!year)
      questions.push({
        field: 'year',
        message: 'Which year should these dates apply to?',
      });
    else {
      const month = String(months.indexOf(dateMonth) + 1).padStart(2, '0');
      draft.startsOn ??= `${year}-${month}-${String(startDay).padStart(2, '0')}`;
      draft.endsOn ??= `${year}-${month}-${String(endDay).padStart(2, '0')}`;
    }
  }
  for (const field of ['startsOn', 'endsOn'] as const) {
    if (!draft[field]) {
      if (!questions.some((q) => q.field === 'year'))
        questions.push({
          field,
          message: `Please provide the ${field === 'startsOn' ? 'start' : 'end'} date (YYYY-MM-DD).`,
        });
    } else if (!isCalendarDate(draft[field]))
      questions.push({
        field,
        message: 'Please provide a real calendar date in YYYY-MM-DD format.',
      });
  }
  if (draft.startsOn && draft.endsOn && draft.endsOn < draft.startsOn)
    questions.push({
      field: 'endsOn',
      message: 'The end date must be on or after the start date.',
    });
  if (
    draft.durationDays !== undefined &&
    (!Number.isInteger(draft.durationDays) ||
      draft.durationDays < 1 ||
      draft.durationDays > 3650)
  )
    questions.push({
      field: 'durationDays',
      message: 'Duration must be a whole number of days between 1 and 3650.',
    });
  if (
    draft.durationDays &&
    draft.startsOn &&
    draft.endsOn &&
    isCalendarDate(draft.startsOn) &&
    isCalendarDate(draft.endsOn)
  ) {
    const windowDays =
      (Date.parse(draft.endsOn) - Date.parse(draft.startsOn)) / 86400000 + 1;
    if (windowDays > 0 && draft.durationDays > windowDays)
      questions.push({
        field: 'durationDays',
        message:
          'The allowance is longer than the date window. Adjust the duration or dates.',
      });
  }
  const policyClass = classes.find((c) => c.id === draft.classId);
  const group = groups.find((g) => g.id === draft.groupId);
  draft.name =
    input.name?.trim() ||
    (policyClass && group ? `${policyClass.name} — ${group.name}` : undefined);
  if (!draft.name)
    questions.push({
      field: 'name',
      message: 'What should this policy be called?',
    });
  return {
    status: questions.length ? 'needs_input' : 'ready',
    draft,
    questions,
  };
}
