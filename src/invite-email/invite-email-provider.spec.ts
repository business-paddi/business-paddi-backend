import { ConfigService } from '@nestjs/config';
import { InviteEmailProvider } from './invite-email-provider.service';
import type { InvitationEmailPayload } from './invitation-email.template';

const send = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send } })),
}));

describe('Resend invite provider error handling', () => {
  const provider = new InviteEmailProvider(
    new ConfigService({ RESEND_KEY: 're_test' }),
  );
  const payload = {
    from: 'a@example.invalid',
    to: 'b@example.invalid',
    subject: 'Invite',
    html: '<p>Invite</p>',
    text: 'Invite',
    attachments: [],
  } satisfies InvitationEmailPayload;
  beforeEach(() => jest.clearAllMocks());
  it('passes the frozen message with an idempotency key and request deadline', async () => {
    send.mockResolvedValue({ data: { id: 'provider-id' }, error: null });
    expect(await provider.send(payload, 'stable-key')).toBe('provider-id');
    expect(send).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        idempotencyKey: 'stable-key',
        signal: expect.any(AbortSignal) as unknown,
      }),
    );
  });
  it.each([
    [429, 'rate_limit_exceeded', true],
    [503, 'internal_server_error', true],
    [409, 'concurrent_idempotent_requests', true],
    [409, 'invalid_idempotent_request', false],
    [422, 'validation_error', false],
    [403, 'restricted_api_key', false],
  ])(
    'classifies status %s / %s for retry',
    async (statusCode, name, retryable) => {
      send.mockResolvedValue({
        data: null,
        error: { statusCode, name, message: 'Do not log recipient details' },
      });
      await expect(provider.send(payload, 'key')).rejects.toMatchObject({
        retryable,
        code: `RESEND_${name}`,
      });
    },
  );
  it('treats a network timeout as ambiguous and retryable', async () => {
    send.mockRejectedValue(new Error('network timeout'));
    await expect(provider.send(payload, 'key')).rejects.toMatchObject({
      retryable: true,
      code: 'PROVIDER_NETWORK_ERROR',
    });
  });
});
