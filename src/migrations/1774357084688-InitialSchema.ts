import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1774357084688 implements MigrationInterface {
    name = 'InitialSchema1774357084688'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "url_stats" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "url_id" uuid NOT NULL, "click_count" bigint NOT NULL DEFAULT '0', "last_accessed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_c4a0189d1db5b6068bf455fd6ea" UNIQUE ("url_id"), CONSTRAINT "REL_c4a0189d1db5b6068bf455fd6e" UNIQUE ("url_id"), CONSTRAINT "PK_e97089bf3c98fa7eae7d4073a29" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "urls" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "short_code" character varying(16) NOT NULL, "original_url" character varying(2048) NOT NULL, "custom_alias" character varying(100), "expires_at" TIMESTAMP WITH TIME ZONE, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" uuid, CONSTRAINT "PK_eaf7bec915960b26aa4988d73b0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e1d29d724dddebbdae878d3f49" ON "urls" ("short_code") `);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(255) NOT NULL, "passwordHash" character varying(255) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "url_stats" ADD CONSTRAINT "FK_c4a0189d1db5b6068bf455fd6ea" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "urls" ADD CONSTRAINT "FK_5b194a4470977b71ff490dfc64b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "urls" DROP CONSTRAINT "FK_5b194a4470977b71ff490dfc64b"`);
        await queryRunner.query(`ALTER TABLE "url_stats" DROP CONSTRAINT "FK_c4a0189d1db5b6068bf455fd6ea"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e1d29d724dddebbdae878d3f49"`);
        await queryRunner.query(`DROP TABLE "urls"`);
        await queryRunner.query(`DROP TABLE "url_stats"`);
    }

}
