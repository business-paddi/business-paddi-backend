import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  IsISO8601,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const supplied = (_: unknown, value: unknown) => value !== undefined;
export class PageQuery {
  @IsOptional() @IsString() @MaxLength(4000) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) search?: string;
}
export class BarcodeQuery {
  @IsString() @IsNotEmpty() @MaxLength(100) barcode!: string;
}
export class InventoryQuery extends PageQuery {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) categoryId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) productId?: string;
  @IsOptional()
  @IsIn(['in_stock', 'low_stock', 'out_of_stock'])
  stockStatus?: string;
  @IsOptional()
  @IsIn([
    'name_asc',
    'name_desc',
    'createdAt_asc',
    'createdAt_desc',
    'sellingPriceMinor_asc',
    'sellingPriceMinor_desc',
    'availableQuantity_asc',
    'availableQuantity_desc',
    'occurredAt_asc',
    'occurredAt_desc',
  ])
  sort?: string;
  @IsOptional()
  @IsIn(['opening', 'receive', 'sale', 'edit', 'category'])
  action?: string;
  @IsOptional() @IsIn(['cash', 'transfer', 'card']) paymentMethod?: string;
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsIn(['today', '7d', '30d']) period?: string;
}
export class CategoryDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?:
    string | null;
}
export class RevisionDto {
  @ValidateIf(supplied)
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision?: number;
}
export class CategoryPatchDto extends RevisionDto {
  @ValidateIf(supplied)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?:
    string | null;
}
export class ProductDto {
  @IsString() @IsNotEmpty() @MaxLength(128) categoryId!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  barcode?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?:
    string | null;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  imageUrl?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(2147483647) packageWeightGrams?:
    number | null;
  @IsInt() @Min(0) @Max(1000000000000) purchaseCostMinor!: number;
  @IsInt() @Min(0) @Max(1000000000000) sellingPriceMinor!: number;
  @ValidateIf(supplied) @IsInt() @Min(0) @Max(1000000) openingUnits = 0;
  @ValidateIf(supplied) @IsInt() @Min(0) @Max(1000000) lowStockThreshold = 0;
}
export class ProductPatchDto extends RevisionDto {
  @ValidateIf(supplied)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  categoryId?: string;
  @ValidateIf(supplied)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  barcode?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?:
    string | null;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  imageUrl?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(2147483647) packageWeightGrams?:
    number | null;
  @ValidateIf(supplied)
  @IsInt()
  @Min(0)
  @Max(1000000000000)
  purchaseCostMinor?: number;
  @ValidateIf(supplied)
  @IsInt()
  @Min(0)
  @Max(1000000000000)
  sellingPriceMinor?: number;
  @ValidateIf(supplied)
  @IsInt()
  @Min(0)
  @Max(1000000)
  lowStockThreshold?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) reason?: string;
}
export class ReceiptDto {
  @IsInt() @Min(1) @Max(1000000) quantity!: number;
  @IsInt() @Min(0) @Max(1000000000000) purchaseCostMinor!: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) supplier?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) note?: string;
}
export class CartLineDto {
  @IsString() @IsNotEmpty() @MaxLength(128) productId!: string;
  @IsInt() @Min(1) @Max(1000000) quantity!: number;
  @ValidateIf(supplied)
  @IsInt()
  @Min(0)
  @Max(1000000000000)
  expectedSellingPriceMinor?: number;
}
export class CartDto extends RevisionDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines!: CartLineDto[];
}
export class QuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines!: CartLineDto[];
}
export class SaleDto extends QuoteDto {
  @IsString() @IsNotEmpty() @MaxLength(128) quoteId!: string;
  @IsInt() @Min(1) @Max(1) quoteRevision!: number;
  @IsIn(['cash', 'transfer', 'card']) paymentMethod!:
    'cash' | 'transfer' | 'card';
  @ValidateIf(supplied)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  tenderMinor?: number;
  @ValidateIf(supplied) @IsBoolean() paymentConfirmed?: boolean;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  customerName?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  customerContact?: string;
}
