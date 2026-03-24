import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Url } from './url.entity';

@Entity('url_stats')
export class UrlStats {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'url_id', unique: true })
  urlId: string;

  @OneToOne(() => Url, (url) => url.stats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'url_id' })
  url: Url;

  // Accumulated click count — incremented via periodic Redis flush
  @Column({ name: 'click_count', type: 'bigint', default: 0 })
  clickCount: number;

  // Set on each flush from Redis; not updated on every redirect hit
  @Column({ name: 'last_accessed_at', type: 'timestamptz', nullable: true })
  lastAccessedAt: Date | null;
}
