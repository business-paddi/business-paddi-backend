import {
  BadGatewayException,
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';
import { AccessTokenGuard } from '../identity/auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../identity/auth-guard/authenticated-request';
import { AuthenticatedRateLimitService } from '../rate-limit/authenticated-rate-limit.service';
import { BusinessAccessService } from './access/business-access.service';

@Injectable()
export class ImageUploadGuard implements CanActivate {
  constructor(
    private readonly access: BusinessAccessService,
    private readonly limits: AuthenticatedRateLimitService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { purpose, businessId } = req.params;
    const user = req.auth.userId;
    if (
      typeof businessId === 'string' &&
      (purpose === 'product' || purpose === 'logo')
    ) {
      await this.access.require(user, businessId, [
        purpose === 'product' ? 'inventory:manage' : 'business:update',
      ]);
    } else if (
      businessId ||
      (purpose !== 'profile' && purpose !== 'onboarding')
    ) {
      throw new BadRequestException('Invalid image purpose');
    }
    await this.limits.consume('image-upload', user, 10, 60);
    return true;
  }
}

@Controller('image-uploads')
@UseGuards(AccessTokenGuard, ImageUploadGuard)
export class ImageUploadController {
  constructor(private readonly config: ConfigService) {}
  @Post([':purpose', ':purpose/:businessId'])
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fields: 0, fileSize: 5 * 1024 * 1024 },
    }),
  )
  async upload(
    @Req() req: AuthenticatedRequest,
    @Param('purpose') purpose: string,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    const bytes = file?.buffer;
    if (!bytes?.length) throw new BadRequestException('Choose an image');
    const maxMB = purpose === 'product' ? 1 : purpose === 'profile' ? 5 : 2;
    if (bytes.length > maxMB * 1024 * 1024)
      throw new PayloadTooLargeException();
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    const webp =
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp)
      throw new BadRequestException('Use a JPEG, PNG or WebP image');
    const cloud_name = this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key = this.config.get<string>('CLOUDINARY_API_KEY'),
      api_secret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (!cloud_name || !api_key || !api_secret)
      throw new ServiceUnavailableException('Image uploads are unavailable');
    return new Promise<{ secureUrl: string; publicId: string }>(
      (resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            cloud_name,
            api_key,
            api_secret,
            resource_type: 'image',
            allowed_formats: ['jpg', 'png', 'webp'],
            format: 'webp',
            overwrite: false,
            public_id: `bp-images/${purpose}/${req.auth.userId}/${randomUUID()}`,
          },
          (error, result) => {
            if (error || !result)
              reject(new BadGatewayException('Image upload failed'));
            else
              resolve({
                secureUrl: result.secure_url,
                publicId: result.public_id,
              });
          },
        );
        stream.on('error', () =>
          reject(new BadGatewayException('Image upload failed')),
        );
        stream.end(bytes);
      },
    );
  }
}
