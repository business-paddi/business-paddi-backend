import { databaseErrorSummary } from '../../scripts/database-error';

describe('Database error diagnostics', () => {
  it('reports non-Error adapter failures and nested causes', () => {
    expect(
      databaseErrorSummary({
        type: 'error',
        cause: { code: 'ECONNRESET', message: 'Connection closed' },
      }),
    ).toContain('ECONNRESET');
  });

  it('redacts credentials and excludes event targets and connection objects', () => {
    const summary = databaseErrorSummary({
      message: 'Failed at postgresql://user:secret@host/database',
      target: { url: 'postgresql://user:secret@host/database' },
    });
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('target');
    expect(summary).toContain('credentials redacted');
  });

  it('handles an ordinary Error', () => {
    expect(databaseErrorSummary(new Error('Connection timed out'))).toContain(
      'Connection timed out',
    );
  });
});
