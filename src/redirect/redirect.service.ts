import { GoneException, Injectable } from '@nestjs/common';
import { UrlsService } from '../urls/urls.service';

@Injectable()
export class RedirectService {
  constructor(private readonly urlsService: UrlsService) {}

  async resolve(shortCode: string): Promise<string> {
    const url = await this.urlsService.findByShortCode(shortCode);

    if (!url || !url.isActive) {
      throw new GoneException('This URL has been removed or does not exist');
    }

    if (url.expiresAt && url.expiresAt < new Date()) {
      throw new GoneException('This URL has expired');
    }

    return url.originalUrl;
  }
}
