import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { appConfig, databaseConfig, redisConfig } from './config/app.config';
import { User } from './entities/user.entity';
import { Url } from './entities/url.entity';
import { UrlStats } from './entities/url-stats.entity';
import { RedisModule } from './redis/redis.module';
import { UrlsModule } from './urls/urls.module';
import { HealthModule } from './health/health.module';
import { RedirectModule } from './redirect/redirect.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('database.host'),
        port: config.get<number>('database.port'),
        username: config.get('database.user'),
        password: config.get('database.password'),
        database: config.get('database.name'),
        entities: [User, Url, UrlStats],
        migrations: ['dist/migrations/*.js'],
        synchronize: false,
        extra: { max: 50 },
      }),
    }),
    RedisModule,
    UrlsModule,
    HealthModule,
    RedirectModule,
  ],
})
export class AppModule {}
