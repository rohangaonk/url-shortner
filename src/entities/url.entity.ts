import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { UrlStats } from './url-stats.entity';

@Entity('urls')
export class Url {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'short_code', length: 16 })
  shortCode: string;

  @Column({ name: 'original_url', length: 2048 })
  originalUrl: string;

  @Column({
    name: 'custom_alias',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  customAlias: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // nullable — no auth required for URL creation
  @Column({ name: 'user_id', type: 'varchar', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, (user) => user.urls, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @OneToOne(() => UrlStats, (stats) => stats.url)
  stats: UrlStats;
}
