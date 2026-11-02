import { InventoryCatalogService } from './inventory-catalog.service';
import { InventoryStockService } from './inventory-stock.service';
import { InventoryCheckoutService } from './inventory-checkout.service';
import { InventoryReportingService } from './inventory-reporting.service';
import { Module } from '@nestjs/common';
import { BusinessAccessService } from '../business/access/business-access.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
@Module({
  controllers: [InventoryController],
  providers: [
    InventoryService,
    BusinessAccessService,
    InventoryCatalogService,
    InventoryStockService,
    InventoryCheckoutService,
    InventoryReportingService,
  ],
})
export class InventoryModule {}
