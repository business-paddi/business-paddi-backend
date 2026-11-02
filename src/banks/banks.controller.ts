import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { BanksCacheInterceptor } from './banks-cache.interceptor';
import { BankQueryDto } from './banks.dto';
import { BanksService } from './banks.service';

// Public reference data, like /api/plans. No business or employee permissions.
@Controller('banks')
@UseInterceptors(BanksCacheInterceptor)
export class BanksController {
  constructor(private readonly banks: BanksService) {}

  @Get()
  list(@Query() query: BankQueryDto) {
    return this.banks.list(query);
  }
}
