import { Injectable } from '@nestjs/common';
import { InventoryCatalogService } from './inventory-catalog.service';
import { InventoryStockService } from './inventory-stock.service';
import { InventoryCheckoutService } from './inventory-checkout.service';
import { InventoryReportingService } from './inventory-reporting.service';
@Injectable()
export class InventoryService {
  constructor(
    private readonly catalog: InventoryCatalogService,
    private readonly stock: InventoryStockService,
    private readonly checkout: InventoryCheckoutService,
    private readonly reporting: InventoryReportingService,
  ) {}
  operationStatus(
    ...args: Parameters<InventoryStockService['operationStatus']>
  ) {
    return this.stock.operationStatus(...args);
  }
  summary(
    ...args: Parameters<InventoryCatalogService['summary']>
  ): ReturnType<InventoryCatalogService['summary']> {
    return this.catalog.summary(...args);
  }
  categories(
    ...args: Parameters<InventoryCatalogService['categories']>
  ): ReturnType<InventoryCatalogService['categories']> {
    return this.catalog.categories(...args);
  }
  createCategory(
    ...args: Parameters<InventoryCatalogService['createCategory']>
  ): ReturnType<InventoryCatalogService['createCategory']> {
    return this.catalog.createCategory(...args);
  }
  editCategory(
    ...args: Parameters<InventoryCatalogService['editCategory']>
  ): ReturnType<InventoryCatalogService['editCategory']> {
    return this.catalog.editCategory(...args);
  }
  deleteCategory(
    ...args: Parameters<InventoryCatalogService['deleteCategory']>
  ): ReturnType<InventoryCatalogService['deleteCategory']> {
    return this.catalog.deleteCategory(...args);
  }
  products(
    ...args: Parameters<InventoryCatalogService['products']>
  ): ReturnType<InventoryCatalogService['products']> {
    return this.catalog.products(...args);
  }
  getProduct(
    ...args: Parameters<InventoryCatalogService['getProduct']>
  ): ReturnType<InventoryCatalogService['getProduct']> {
    return this.catalog.getProduct(...args);
  }
  barcode(
    ...args: Parameters<InventoryCatalogService['barcode']>
  ): ReturnType<InventoryCatalogService['barcode']> {
    return this.catalog.barcode(...args);
  }
  createProduct(
    ...args: Parameters<InventoryCatalogService['createProduct']>
  ): ReturnType<InventoryCatalogService['createProduct']> {
    return this.catalog.createProduct(...args);
  }
  editProduct(
    ...args: Parameters<InventoryCatalogService['editProduct']>
  ): ReturnType<InventoryCatalogService['editProduct']> {
    return this.catalog.editProduct(...args);
  }
  receive(
    ...args: Parameters<InventoryStockService['receive']>
  ): ReturnType<InventoryStockService['receive']> {
    return this.stock.receive(...args);
  }
  movements(
    ...args: Parameters<InventoryStockService['movements']>
  ): ReturnType<InventoryStockService['movements']> {
    return this.stock.movements(...args);
  }
  shortages(
    ...args: Parameters<InventoryStockService['shortages']>
  ): ReturnType<InventoryStockService['shortages']> {
    return this.stock.shortages(...args);
  }
  cart(
    ...args: Parameters<InventoryCheckoutService['cart']>
  ): ReturnType<InventoryCheckoutService['cart']> {
    return this.checkout.cart(...args);
  }
  saveCart(
    ...args: Parameters<InventoryCheckoutService['saveCart']>
  ): ReturnType<InventoryCheckoutService['saveCart']> {
    return this.checkout.saveCart(...args);
  }
  quote(
    ...args: Parameters<InventoryCheckoutService['quote']>
  ): ReturnType<InventoryCheckoutService['quote']> {
    return this.checkout.quote(...args);
  }
  completeSale(
    ...args: Parameters<InventoryCheckoutService['completeSale']>
  ): ReturnType<InventoryCheckoutService['completeSale']> {
    return this.checkout.completeSale(...args);
  }
  sales(
    ...args: Parameters<InventoryReportingService['sales']>
  ): ReturnType<InventoryReportingService['sales']> {
    return this.reporting.sales(...args);
  }
  sale(
    ...args: Parameters<InventoryReportingService['sale']>
  ): ReturnType<InventoryReportingService['sale']> {
    return this.reporting.sale(...args);
  }
  analytics(
    ...args: Parameters<InventoryReportingService['analytics']>
  ): ReturnType<InventoryReportingService['analytics']> {
    return this.reporting.analytics(...args);
  }
}
