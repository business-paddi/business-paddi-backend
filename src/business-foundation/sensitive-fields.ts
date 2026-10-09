import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error(
      'Payroll encryption key must be a canonical base64-encoded 32-byte key',
    );
  }
  return key;
}

// The version is the key identifier. Retain v1 keys for decryption during future rotation.
export function encryptPayrollField(value: string, keyBase64: string): string {
  if (!value.trim()) throw new Error('Sensitive fields must not be empty');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyBase64), iv);
  cipher.setAAD(Buffer.from('business-paddi:payroll:v1'));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return [
    'enc',
    'v1',
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

export function decryptPayrollField(value: string, keyBase64: string): string {
  if (!/^enc:v1:[a-f0-9]{24}:[a-f0-9]{32}:([a-f0-9]{2})+$/.test(value)) {
    throw new Error('Invalid encrypted payroll field');
  }
  const [, , iv, tag, ciphertext] = value.split(':');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(keyBase64),
    Buffer.from(iv, 'hex'),
  );
  decipher.setAAD(Buffer.from('business-paddi:payroll:v1'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

// Future ordinary list endpoints must opt into safe fields instead of returning ORM rows.
export const EMPLOYEE_PUBLIC_SELECT = {
  id: true,
  businessId: true,
  fullName: true,
  jobTitle: true,
  state: true,
  employeeTypeId: true,
  managerEmployeeId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;
