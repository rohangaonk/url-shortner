import { Module } from '@nestjs/common';
import { UrlsModule } from '../urls/urls.module';
import { RedirectController } from './redirect.controller';
import { RedirectService } from './redirect.service';

@Module({
  imports: [UrlsModule],
  controllers: [RedirectController],
  providers: [RedirectService],
})
export class RedirectModule {}
