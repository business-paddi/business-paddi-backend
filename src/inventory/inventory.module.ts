import { Module } from '@nestjs/common';
import { BusinessAccessService } from '../business/business-access.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, BusinessAccessService],
})
export class InventoryModule {}
