import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { BusinessCacheInterceptor } from '../business/business-cache.interceptor';
import { InventoryService } from './inventory.service';
import { InventoryErrorFilter } from './inventory-error.filter';
import {
  BarcodeQuery,
  CategoryDto,
  CategoryPatchDto,
  CartDto,
  InventoryQuery,
  PageQuery,
  ProductDto,
  ProductPatchDto,
  QuoteDto,
  ReceiptDto,
  RevisionDto,
  SaleDto,
} from './inventory.dto';
import { revision } from './inventory.helpers';
import { Type } from 'class-transformer';
class DeleteRevisionQuery extends RevisionDto {
  @Type(() => Number) declare expectedRevision?: number;
}

@Controller('businesses/:businessId/inventory')
@UseGuards(AccessTokenGuard)
@UseFilters(InventoryErrorFilter)
@UseInterceptors(BusinessCacheInterceptor)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}
  @Get('summary') summary(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.summary(req.auth.userId, b, q.categoryId);
  }
  @Get('categories') categories(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: PageQuery,
  ) {
    return this.inventory.categories(req.auth.userId, b, q);
  }
  @Post('categories') createCategory(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() input: CategoryDto,
  ) {
    return this.inventory.createCategory(req.auth.userId, b, input);
  }
  @Patch('categories/:id') editCategory(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
    @Body() input: CategoryPatchDto,
    @Headers('if-match') match?: string,
  ) {
    return this.inventory.editCategory(
      req.auth.userId,
      b,
      id,
      input,
      revision(input.expectedRevision, match),
    );
  }
  @Delete('categories/:id') @HttpCode(204) deleteCategory(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
    @Query() input: DeleteRevisionQuery,
    @Headers('if-match') match?: string,
  ) {
    return this.inventory.deleteCategory(
      req.auth.userId,
      b,
      id,
      revision(input.expectedRevision, match),
    );
  }
  @Get('products') products(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.products(req.auth.userId, b, q);
  }
  @Get('products/by-barcode') barcode(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() query: BarcodeQuery,
  ) {
    return this.inventory.barcode(req.auth.userId, b, query.barcode);
  }
  @Get('products/:id') product(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
  ) {
    return this.inventory.getProduct(req.auth.userId, b, id);
  }
  @Post('products') createProduct(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() input: ProductDto,
  ) {
    return this.inventory.createProduct(req.auth.userId, b, input);
  }
  @Patch('products/:id') editProduct(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
    @Body() input: ProductPatchDto,
    @Headers('if-match') match?: string,
  ) {
    return this.inventory.editProduct(
      req.auth.userId,
      b,
      id,
      input,
      revision(input.expectedRevision, match),
    );
  }
  @Post('products/:id/receipts') receive(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
    @Body() input: ReceiptDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.inventory.receive(req.auth.userId, b, id, input, key);
  }
  @Get('movements') movements(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.movements(req.auth.userId, b, q);
  }
  @Get('products/:id/price-history') priceHistory(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.movements(
      req.auth.userId,
      b,
      { ...q, productId: id },
      true,
    );
  }
  @Get('products/:id/shortages') shortages(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.shortages(req.auth.userId, b, id, q);
  }
  @Get('cart') cart(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
  ) {
    return this.inventory.cart(req.auth.userId, b);
  }
  @Put('cart') cartSave(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() input: CartDto,
    @Headers('if-match') match?: string,
  ) {
    return this.inventory.saveCart(
      req.auth.userId,
      b,
      input,
      revision(input.expectedRevision, match),
    );
  }
  @Post('sales/quote') quote(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() input: QuoteDto,
  ) {
    return this.inventory.quote(req.auth.userId, b, input);
  }
  @Post('sales') saleCreate(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() input: SaleDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.inventory.completeSale(req.auth.userId, b, input, key);
  }
  @Get('sales') sales(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.sales(req.auth.userId, b, q);
  }
  @Get('sales/:id') sale(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('id') id: string,
  ) {
    return this.inventory.sale(req.auth.userId, b, id);
  }
  @Get('analytics') analytics(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.analytics(req.auth.userId, b, q);
  }
}
