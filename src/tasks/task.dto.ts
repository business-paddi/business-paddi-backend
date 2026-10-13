import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const provided = (_: unknown, v: unknown) => v !== undefined;
export const TASK_STATUSES = [
  'unassigned',
  'todo',
  'in_progress',
  'in_review',
  'changes_requested',
  'completed',
  'failed',
  'cancelled',
];
export class TaskCreateDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) title!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(10000) description?:
    string | null;
  @ValidateIf(provided)
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;
  @IsOptional() @IsISO8601({ strict: true }) dueAt?: string | null;
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  assigneeMemberId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) employeeId?: string;
  @ValidateIf(provided) @IsBoolean() requiresReview?: boolean;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) reviewerMemberId?:
    string | null;
}
export class RevisionDto {
  @IsInt() @Min(1) revision!: number;
}
export class TaskPatchDto extends RevisionDto {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(10000) description?:
    string | null;
  @ValidateIf(provided)
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;
  @IsOptional() @IsISO8601({ strict: true }) dueAt?: string | null;
  @ValidateIf(provided) @IsBoolean() requiresReview?: boolean;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) reviewerMemberId?:
    string | null;
}
export class AssignmentDto extends RevisionDto {
  @IsString() @IsNotEmpty() @MaxLength(128) assigneeMemberId!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) employeeId?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason?: string;
}
export class ReasonDto extends RevisionDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(1000) reason!: string;
}
export class ReviewDto extends RevisionDto {
  @IsIn(['accept', 'request_changes', 'fail']) decision!:
    'accept' | 'request_changes' | 'fail';
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason?: string;
}
class EvidenceLinkDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) label?:
    string | null;
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(2000)
  url!: string;
}
export class EvidenceDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(10000) notes?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => EvidenceLinkDto)
  links?: EvidenceLinkDto[];
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  imageIds?: string[];
}
export class SubmissionDto extends EvidenceDto {
  @IsInt() @Min(1) revision!: number;
}
export class CommentDto extends SubmissionDto {}
export class TaskQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
  @IsOptional() @IsString() @MaxLength(3000) cursor?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsIn(TASK_STATUSES) status?: string;
  @IsOptional() @IsIn(['low', 'normal', 'high', 'urgent']) priority?: string;
  @IsOptional() @IsString() @MaxLength(128) assigneeMemberId?: string;
  @IsOptional() @IsString() @MaxLength(128) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(128) createdByMemberId?: string;
  @IsOptional() @IsIn(['true', 'false']) overdue?: string;
  @IsOptional() @IsISO8601({ strict: true }) dueFrom?: string;
  @IsOptional() @IsISO8601({ strict: true }) dueTo?: string;
  @IsOptional() @IsIn(['updatedAt_desc', 'dueAt_asc']) sort = 'updatedAt_desc';
  @IsOptional() @IsString() @MaxLength(128) businessId?: string;
  @IsOptional() @IsIn(['visible', 'assigned_to_me', 'created_by_me']) scope =
    'visible';
}
export class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
  @IsOptional() @IsString() @MaxLength(3000) cursor?: string;
}
export class DashboardTaskQueryDto extends TaskQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) override limit =
    10;
}
export class AssigneeQueryDto extends PageDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsIn(['member', 'employee', 'all']) kind = 'all';
}
export class ReviewerQueryDto extends PageDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsString() @MaxLength(128) assigneeMemberId?: string;
}
export class AnalyticsQueryDto extends PageDto {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsIn(['member', 'employee']) groupBy = 'member';
  @IsOptional() @IsIn(['business', 'me']) scope = 'business';
  @IsOptional() @IsString() @MaxLength(128) memberId?: string;
  @IsOptional() @IsString() @MaxLength(128) employeeId?: string;
}
export class UploadIntentDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @IsString() @MaxLength(100) contentType!: string;
  @IsInt() @Min(1) sizeBytes!: number;
}
