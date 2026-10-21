import type { Reference } from './policy-parser';

export const INFERENCE_FIELDS = [
  'audience',
  'groupIds',
  'employeeIds',
  'employmentTypeIds',
  'startsOn',
  'endsOn',
  'durationDays',
  'constraints',
] as const;
export type InferenceField = (typeof INFERENCE_FIELDS)[number];
export type InferenceQuestion = {
  field: InferenceField;
  message: string;
  options?: Reference[];
};
export type PolicyExtraction = {
  name: string | null;
  summary: string;
  groupIds: string[];
  employeeIds: string[];
  employmentTypeIds: string[];
  allEmployees: boolean | null;
  durationDays: number | null;
  startsOn: string | null;
  endsOn: string | null;
  constraints: string[];
  missing: Array<{ field: InferenceField; message: string }>;
};
export type InferenceReferences = {
  selectedClass: Reference;
  groups: Reference[];
  employmentTypes: Reference[];
  employees: Reference[];
  employeeDirectoryTruncated: boolean;
  canViewEmployees: boolean;
};
export type PolicyInferenceResult = {
  status: 'needs_input' | 'ready_for_review';
  model: string;
  draft: Omit<PolicyExtraction, 'missing'> & {
    classId: string;
    className: string;
  };
  questions: InferenceQuestion[];
  affectedPeople: {
    candidateCount: number | null;
    constraintsEvaluated: false;
    groups: Reference[];
    employees: Reference[];
    employmentTypes: Reference[];
    matching: 'groups_or_named_employees_then_employment_type';
  };
  continuation: {
    action: 'describe_policy';
    classId: string;
    text: string;
    followUps: string[];
  };
  persistence: {
    canCreateWithCurrentApi: boolean;
    blockers: string[];
    createPayload: {
      classId: string;
      groupId: string;
      name: string;
      startsOn: string;
      endsOn: string;
      durationDays?: number;
    } | null;
  };
};
