import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PolicyChatReplyDto } from './policy-chat.dto';

const validateReply = (body: unknown) =>
  validate(plainToInstance(PolicyChatReplyDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('policy chat HTTP inputs', () => {
  it('accepts button requests and typed class names', async () => {
    for (const body of [
      { action: 'create_class' },
      { action: 'use_class', classId: 'vacation' },
      { action: 'save_classes', text: 'Holiday and Vacation' },
      { action: 'save_classes', names: ['Benefits'] },
      {
        action: 'describe_policy',
        classId: 'vacation',
        text: 'One week in December',
        followUps: ['Engineering only'],
        answer: '2027',
      },
    ]) {
      expect(await validateReply(body)).toHaveLength(0);
    }
  });
  it('rejects arbitrary actions, forged identity and response objects as requests', async () => {
    for (const body of [
      { action: 'delete_class' },
      { action: 'help', userId: 'other-user' },
      { action: 'help', businessName: 'Other business' },
      { action: 'help', messages: [] },
      { action: 'help', state: { classId: 'foreign' } },
    ]) {
      expect((await validateReply(body)).length).toBeGreaterThan(0);
    }
  });
  it('rejects invalid class input sizes and types', async () => {
    for (const body of [
      { action: 'save_classes', names: [] },
      { action: 'save_classes', names: [123] },
      { action: 'save_classes', text: 'x'.repeat(2001) },
      { action: 'use_class', classId: '' },
      { action: 'describe_policy', followUps: [123] },
      { action: 'describe_policy', followUps: Array(11).fill('answer') },
      { action: 'describe_policy', answer: 'x'.repeat(1001) },
    ]) {
      expect((await validateReply(body)).length).toBeGreaterThan(0);
    }
  });
});
