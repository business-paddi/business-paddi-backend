import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskAccessService } from './task-access.service';
import { decodeCursor, encodeCursor } from './task.utils';
import type { UploadIntentDto } from './task.dto';
const formats: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
@Injectable()
export class TaskImagesService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TaskImagesService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly secret: string;
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccessService,
    private readonly config: ConfigService,
  ) {
    this.secret = config.getOrThrow('VERIFICATION_CODE_PEPPER');
  }
  private credentials() {
    const cloud_name = this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key = this.config.get<string>('CLOUDINARY_API_KEY'),
      api_secret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (!cloud_name || !api_key || !api_secret)
      throw new ServiceUnavailableException({
        code: 'TASK_IMAGE_STORAGE_UNAVAILABLE',
        message: 'Private image storage is not configured',
      });
    return { cloud_name, api_key, api_secret };
  }
  async intent(
    userId: string,
    businessId: string,
    taskId: string,
    b: UploadIntentDto,
  ) {
    const credentials = this.credentials();
    if (b.sizeBytes > 5 * 1024 * 1024)
      throw new PayloadTooLargeException('Maximum image size is 5 MB');
    if (!formats[b.contentType])
      throw new UnsupportedMediaTypeException('Use JPEG, PNG or WebP');
    const image = await this.prisma.$transaction(
      async (db) => {
        const a = await this.access.context(userId, businessId, db, true);
        const t = await this.access.task(a, taskId, db, true);
        if (!this.access.canComment(a, t))
          throw new ForbiddenException(
            'Only task participants and managers can upload evidence',
          );
        if (t.assigneeMemberId === a.member.id)
          await this.access.ownAssignment(a, t, db);
        return db.taskImage.create({
          data: {
            taskId,
            uploadedByUserId: userId,
            publicId: `business-paddi/task-evidence/${randomUUID()}`,
            name: [...b.name]
              .map((ch) =>
                ch.charCodeAt(0) < 32 || ch === '/' || ch === '\\' ? '_' : ch,
              )
              .join(''),
            contentType: b.contentType,
            sizeBytes: b.sizeBytes,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
      },
      { maxWait: 15000, timeout: 30000 },
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const fields = {
      timestamp,
      public_id: image.publicId,
      type: 'authenticated',
      overwrite: false,
    };
    return {
      imageId: image.id,
      uploadUrl: `https://api.cloudinary.com/v1_1/${credentials.cloud_name}/image/upload`,
      method: 'POST',
      headers: {},
      expiresAt: image.expiresAt,
      fields: {
        ...fields,
        api_key: credentials.api_key,
        signature: cloudinary.utils.api_sign_request(
          fields,
          credentials.api_secret,
        ),
      },
    };
  }
  async finalize(
    userId: string,
    businessId: string,
    taskId: string,
    imageId: string,
  ) {
    const a = await this.access.context(userId, businessId);
    await this.access.task(a, taskId);
    const image = await this.prisma.taskImage.findFirst({
      where: { id: imageId, taskId, uploadedByUserId: userId },
    });
    if (!image || image.status === 'deleted')
      throw new NotFoundException('Image not found');
    if (['deleting', 'deleted'].includes(image.status))
      throw new NotFoundException('Image not found');
    if (image.status !== 'pending')
      return { image: this.present(image, businessId) };
    if (image.expiresAt < new Date())
      throw new BadRequestException('Upload intent expired');
    const c = this.credentials();
    let resource: {
      bytes: number;
      width: number;
      height: number;
      format: string;
      version: number;
      type: string;
      public_id: string;
      resource_type: string;
    };
    try {
      resource = (await cloudinary.api.resource(image.publicId, {
        ...c,
        resource_type: 'image',
        type: 'authenticated',
      })) as typeof resource;
    } catch (error) {
      if ((error as { http_code?: number }).http_code === 404)
        throw new BadRequestException('Uploaded image not found');
      throw new ServiceUnavailableException(
        'Image storage unavailable; retry finalization',
      );
    }
    if (
      resource.type !== 'authenticated' ||
      resource.resource_type !== 'image' ||
      resource.public_id !== image.publicId ||
      !Object.values(formats).includes(resource.format)
    )
      throw new UnsupportedMediaTypeException(
        'Uploaded content must be an authenticated JPEG, PNG or WebP image',
      );
    if (
      resource.bytes > 5 * 1024 * 1024 ||
      ![
        resource.bytes,
        resource.width,
        resource.height,
        resource.version,
      ].every(Number.isSafeInteger) ||
      resource.width < 1 ||
      resource.height < 1 ||
      resource.width > 8000 ||
      resource.height > 8000 ||
      resource.width * resource.height > 32000000
    )
      throw new PayloadTooLargeException(
        'Image exceeds byte or dimension limits',
      );
    if (
      resource.bytes !== image.sizeBytes ||
      resource.format !== formats[image.contentType]
    )
      throw new BadRequestException('Uploaded bytes do not match intent');
    const saved = await this.prisma.$transaction(
      async (db) => {
        const a2 = await this.access.context(userId, businessId, db, true);
        const t = await this.access.task(a2, taskId, db, true);
        if (t.assigneeMemberId === a2.member.id)
          await this.access.ownAssignment(a2, t, db);
        const current = await db.taskImage.findUniqueOrThrow({
          where: { id: imageId },
        });
        if (current.status !== 'pending')
          throw new BadRequestException('Image is no longer pending');
        return db.taskImage.update({
          where: { id: imageId },
          data: {
            status: 'finalized',
            width: resource.width,
            height: resource.height,
            version: resource.version,
            expiresAt: new Date(Date.now() + 7 * 86400000),
          },
        });
      },
      { maxWait: 15000, timeout: 30000 },
    );
    return { image: this.present(saved, businessId) };
  }
  present(
    image: {
      id: string;
      taskId: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
    },
    businessId: string,
  ) {
    const expiresAt = new Date(Date.now() + 15 * 60000);
    const token = encodeCursor(
      this.secret,
      { imageId: image.id },
      { expiresAt: expiresAt.toISOString() },
    );
    const origin = this.config
      .get<string>('TASK_PUBLIC_API_URL', 'http://localhost:5000')
      .replace(/\/$/, '');
    return {
      id: image.id,
      name: image.name,
      contentType: image.contentType,
      sizeBytes: image.sizeBytes,
      width: image.width,
      height: image.height,
      url: `${origin}/api/businesses/${businessId}/tasks/${image.taskId}/images/${image.id}/content?token=${encodeURIComponent(token)}`,
      urlExpiresAt: expiresAt.toISOString(),
    };
  }
  async evidence(
    db: Prisma.TransactionClient,
    e: Prisma.JsonValue,
    businessId: string,
  ) {
    const data = e as {
      notes: string | null;
      links: unknown[];
      imageIds: string[];
    };
    const images = await db.taskImage.findMany({
      where: { id: { in: data.imageIds ?? [] }, status: 'attached' },
    });
    return {
      notes: data.notes,
      links: data.links,
      images: images.map((i) => this.present(i, businessId)),
    };
  }
  async content(
    userId: string,
    businessId: string,
    taskId: string,
    imageId: string,
    token: string,
  ) {
    const a = await this.access.context(userId, businessId);
    await this.access.task(a, taskId);
    const image = await this.prisma.taskImage.findFirst({
      where: { id: imageId, taskId, status: { in: ['attached', 'finalized'] } },
    });
    if (!image) throw new NotFoundException('Image not found');
    if (image.status === 'finalized' && image.uploadedByUserId !== userId)
      throw new ForbiddenException('Draft image is private');
    const signed = decodeCursor<{ expiresAt: string }>(
      this.secret,
      { imageId },
      token,
    );
    if (!signed || new Date(signed.expiresAt) < new Date())
      throw new ForbiddenException('Image URL expired');
    const c = this.credentials();
    const url = cloudinary.url(image.publicId, {
      ...c,
      resource_type: 'image',
      type: 'authenticated',
      sign_url: true,
      secure: true,
      version: image.version ?? undefined,
      format: formats[image.contentType],
    });
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok)
      throw new ServiceUnavailableException('Image unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024)
      throw new ServiceUnavailableException('Image unavailable');
    return { bytes, contentType: image.contentType };
  }
  async remove(
    userId: string,
    businessId: string,
    taskId: string,
    imageId: string,
  ) {
    await this.prisma.$transaction(
      async (db) => {
        const a = await this.access.context(userId, businessId, db, true);
        await this.access.task(a, taskId, db, true);
        const image = await db.taskImage.findFirst({
          where: { id: imageId, taskId, uploadedByUserId: userId },
        });
        if (!image) throw new NotFoundException('Image not found');
        if (image.attachedTo)
          throw new BadRequestException('Submitted images are immutable');
        await db.taskImage.update({
          where: { id: imageId },
          data: { status: 'deleting' },
        });
      },
      { maxWait: 15000, timeout: 30000 },
    );
    await this.cleanup();
    return { deleted: true };
  }
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.cleanup().catch(() =>
          this.logger.warn('Task image cleanup failed; will retry'),
        ),
      60000,
    );
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  async cleanup() {
    if (this.running || !this.config.get('CLOUDINARY_API_SECRET')) return;
    this.running = true;
    try {
      const rows = await this.prisma.taskImage.findMany({
        where: {
          attachedTo: null,
          OR: [
            { status: 'deleting' },
            {
              status: { in: ['pending', 'finalized'] },
              expiresAt: { lt: new Date() },
            },
          ],
        },
        take: 100,
      });
      for (const row of rows) {
        // Task row lock serializes attachment against cleanup; mark first, then delete provider blob.
        const marked = await this.prisma.$transaction(
          async (db) => {
            await db.$queryRaw`SELECT "id" FROM "BusinessTask" WHERE "id"=${row.taskId} FOR UPDATE`;
            return db.taskImage.updateMany({
              where: {
                id: row.id,
                attachedTo: null,
                OR: [
                  { status: 'deleting' },
                  {
                    status: { in: ['pending', 'finalized'] },
                    expiresAt: { lt: new Date() },
                  },
                ],
              },
              data: { status: 'deleting' },
            });
          },
          { maxWait: 15000, timeout: 30000 },
        );
        if (!marked.count) continue;
        await cloudinary.uploader.destroy(row.publicId, {
          ...this.credentials(),
          type: 'authenticated',
          resource_type: 'image',
          invalidate: true,
        });
        await this.prisma.taskImage.update({
          where: { id: row.id },
          data: { status: 'deleted' },
        });
      }
    } finally {
      this.running = false;
    }
  }
}
