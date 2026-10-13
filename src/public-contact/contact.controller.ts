import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ContactDto } from './contact.dto';
import { ContactRateLimitError, ContactService } from './contact.service';
@Controller('public')
export class ContactController {
  constructor(private readonly service: ContactService) {}
  @Post('contact-requests')
  @HttpCode(202)
  async receive(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: ContactDto,
    @Headers('idempotency-key') key?: string,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return await this.service.receive(
        req.ip ?? req.socket.remoteAddress ?? 'unknown',
        body,
        key,
      );
    } catch (e) {
      if (e instanceof ContactRateLimitError)
        res.setHeader('Retry-After', e.retryAfter);
      throw e;
    }
  }
}
