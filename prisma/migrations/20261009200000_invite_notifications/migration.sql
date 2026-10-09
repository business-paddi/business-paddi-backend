CREATE TABLE "UserNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'business_invite',
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserNotification_inviteId_key" ON "UserNotification"("inviteId");
CREATE INDEX "UserNotification_userId_createdAt_idx" ON "UserNotification"("userId", "createdAt");
CREATE INDEX "BusinessInvite_email_createdAt_idx" ON "BusinessInvite"("email", "createdAt");
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "BusinessInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
