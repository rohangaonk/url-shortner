import {
  IsDateString,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateUrlDto {
  @IsUrl({ require_protocol: true })
  originalUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customAlias?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
