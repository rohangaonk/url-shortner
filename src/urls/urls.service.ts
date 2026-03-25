import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { Url } from '../entities/url.entity';
import { CreateUrlDto } from './dto/create-url.dto';
import { REDIS_CLIENT } from '../redis/redis.module';

const BASE62_CHARS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// 62^6 — ensures all generated codes are exactly 7 chars
const BASE62_OFFSET = 56_800_235_584;

// Total 7-char code space: 62^7 - 62^6
const SPACE_SIZE = BigInt(62 ** 7 - 62 ** 6); // 3_464_814_370_624

// Mersenne prime (2^31 - 1), coprime to SPACE_SIZE — Knuth multiplicative shuffle
const KNUTH_MULT = 2_147_483_647n;

function toBase62(n: number): string {
  if (n === 0) return '0';
  let result = '';
  while (n > 0) {
    result = BASE62_CHARS[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

// Maps sequential counter → pseudo-random index in [0, SPACE_SIZE)
// Bijective: no two counters produce the same code
function shuffleCounter(n: number): number {
  return Number((BigInt(n) * KNUTH_MULT) % SPACE_SIZE);
}

@Injectable()
export class UrlsService {
  constructor(
    @InjectRepository(Url)
    private readonly urlRepo: Repository<Url>,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  async create(dto: CreateUrlDto): Promise<{ shortUrl: string }> {
    const shortCode = dto.customAlias ?? (await this.generateShortCode());
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    try {
      const url = this.urlRepo.create({
        shortCode,
        originalUrl: dto.originalUrl,
        customAlias: dto.customAlias ?? null,
        expiresAt,
        isActive: true,
        userId: null,
      });
      await this.urlRepo.save(url);
    } catch (e) {
      if (
        e instanceof QueryFailedError &&
        (e as QueryFailedError & { code: string }).code === '23505'
      ) {
        throw new ConflictException(
          `Short code "${shortCode}" is already taken`,
        );
      }
      throw e;
    }

    const baseUrl = this.config.get<string>('app.baseUrl');
    return { shortUrl: `${baseUrl}/${shortCode}` };
  }

  async findByShortCode(shortCode: string): Promise<Url | null> {
    const cacheKey = `url:${shortCode}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        ...parsed,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        createdAt: new Date(parsed.createdAt),
      } as Url;
    }

    const url = await this.urlRepo.findOne({ where: { shortCode } });
    if (!url || !url.isActive) return url ?? null;

    await this.cacheUrl(cacheKey, url);
    return url;
  }

  async softDelete(id: string): Promise<void> {
    const url = await this.urlRepo.findOne({ where: { id } });
    if (!url) {
      throw new NotFoundException(`URL with id "${id}" not found`);
    }

    await this.redis.del(`url:${url.shortCode}`);
    await this.urlRepo.update(id, { isActive: false });
  }

  private async cacheUrl(cacheKey: string, url: Url): Promise<void> {
    if (url.expiresAt) {
      const ttlSeconds = Math.floor(
        (url.expiresAt.getTime() - Date.now()) / 1000,
      );
      if (ttlSeconds > 0) {
        await this.redis.set(cacheKey, JSON.stringify(url), 'EX', ttlSeconds);
      }
    } else {
      await this.redis.set(cacheKey, JSON.stringify(url));
    }
  }

  private async generateShortCode(): Promise<string> {
    const counter = await this.redis.incr('url:counter');
    const shuffled = shuffleCounter(counter);
    return toBase62(BASE62_OFFSET + shuffled);
  }
}
