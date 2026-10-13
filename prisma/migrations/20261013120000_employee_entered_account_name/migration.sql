BEGIN;
-- Preserve an explicitly supplied replacement name as unverified input. Clear
-- the old name when the bank identity changes without a replacement.
CREATE OR REPLACE FUNCTION invalidate_bank_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bankCode" IS DISTINCT FROM OLD."bankCode" OR NEW."accountNumber" IS DISTINCT FROM OLD."accountNumber" THEN
    IF NEW."accountName" IS NOT DISTINCT FROM OLD."accountName" THEN
      NEW."accountName" := NULL;
    END IF;
    NEW."accountVerificationStatus" := 'unverified';
    NEW."verificationJobStatus" := 'pending';
    NEW."verificationMode" := NULL;
    NEW."verificationAttemptCount" := 0;
    NEW."accountVerifiedAt" := NULL;
    NEW."accountVerificationFailureReason" := NULL;
    NEW."lastAccountValidationAt" := NULL;
    NEW."nextVerificationAttemptAt" := NULL;
    NEW."paymentStatus" := 'blocked';
    NEW."paymentBlockedReason" := 'bank_details_changed';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
