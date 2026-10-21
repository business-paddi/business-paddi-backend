import type { PolicyChatReplyDto } from './policy-chat.dto';
import type { PolicyInferenceResult } from './policy-inference.types';

export type ChatClass = { id: string; name: string };
export type PolicyChatReply = {
  id: string;
  label: string;
  request: PolicyChatReplyDto;
};
export type PolicyChatResponse = {
  flowVersion: 1;
  mode: 'guided';
  step:
    | 'create_class'
    | 'choose_class'
    | 'policy_ready'
    | 'clarify_policy'
    | 'review_policy'
    | 'read_only';
  context: {
    businessId: string;
    businessName: string;
    firstName: string;
    policyCount: number;
    classCount: number;
    canCreate: boolean;
  };
  messages: Array<{ id: string; role: 'assistant'; text: string }>;
  classes: ChatClass[];
  replies: PolicyChatReply[];
  input:
    | { kind: 'none' }
    | {
        kind: 'policy_description' | 'policy_clarification';
        placeholder: string;
        maxLength: number;
        submitLabel: string;
        submit: PolicyChatReplyDto;
        field: 'text' | 'answer';
      }
    | {
        kind: 'class_names';
        placeholder: string;
        maxLength: number;
        submitLabel: string;
        submit: { action: 'save_classes' };
        field: 'text';
      };
  selectedClass?: ChatClass;
  nextStep?: { type: 'policy_form'; classId: string };
  effect?: { type: 'classes_saved'; classIds: string[]; createdCount: number };
  inference?: PolicyInferenceResult;
};
