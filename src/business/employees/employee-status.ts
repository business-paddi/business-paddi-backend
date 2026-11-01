export const EMPLOYEE_LOCKED_STATUSES = [
  'archived',
  'scheduled_for_deletion',
  'deleted',
] as const;
export const isEmployeeLocked = (status: string) =>
  EMPLOYEE_LOCKED_STATUSES.some((item) => item === status);
