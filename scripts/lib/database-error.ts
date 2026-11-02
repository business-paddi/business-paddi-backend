// Some WebSocket/adapter failures are event objects rather than Error instances.
// Only report selected diagnostic fields, never entire connection/event objects.
export function databaseErrorSummary(error: unknown, depth = 0): string {
  const redact = (text: string) => {
    const connection = process.env.DATABASE_URL;
    let safe = connection
      ? text.replaceAll(connection, '[database URL redacted]')
      : text;
    if (connection) {
      try {
        const password = new URL(connection).password;
        if (password) {
          safe = safe.replaceAll(password, '[redacted]');
          const decoded = decodeURIComponent(password);
          if (decoded) safe = safe.replaceAll(decoded, '[redacted]');
        }
      } catch {
        /* Invalid connection URLs must not prevent error reporting. */
      }
    }
    return safe.replace(
      /(postgres(?:ql)?:\/\/)[^\s@]+@/gi,
      '$1[credentials redacted]@',
    );
  };
  if (typeof error === 'string') return redact(error);
  if (!error || typeof error !== 'object')
    return `Database operation failed (${typeof error})`;
  const record = error as Record<string, unknown>;
  const details: string[] = [];
  for (const key of [
    'name',
    'message',
    'code',
    'type',
    'errno',
    'syscall',
    'address',
    'port',
  ]) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number')
      details.push(`${key}: ${redact(String(value))}`);
  }
  if (depth < 3) {
    for (const key of ['cause', 'error', 'originalError']) {
      if (record[key] !== undefined && record[key] !== error)
        details.push(`${key}: ${databaseErrorSummary(record[key], depth + 1)}`);
    }
  }
  return details.length
    ? details.join('\n')
    : 'Database adapter returned a failure object without diagnostic fields';
}
