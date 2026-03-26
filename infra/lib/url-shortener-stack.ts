import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

// Non-sensitive DB config — only the password lives in Secrets Manager.
const DB_NAME = 'urlshortener';

export class UrlShortenerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Secrets Manager ───────────────────────────────────────────────
    // Create this secret manually before deploying:
    const dbSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'DbSecret',
      'url-shortener/db',
    );

    // ── VPC ──────────────────────────────────────────────────────────────
    // natGateways: 0 saves ~$35/month. ECS tasks and RDS run in public
    // subnets — RDS needs publiclyAccessible + IGW route for laptop access.
    // ElastiCache stays in isolated subnets (Redis never needs internet).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
        // Keep an isolated tier for ElastiCache (Redis never needs internet)
        // Actual isolated subnets are still used by ElastiCache subnet group.
      ],
    });

    // ── Security Groups ───────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB - allow HTTP inbound from internet',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc,
      description: 'ECS tasks - allow inbound from ALB only',
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(3000));

    const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc,
      description: 'RDS - allow Postgres from ECS tasks and deployer laptop',
    });
    rdsSg.addIngressRule(ecsSg, ec2.Port.tcp(5432));
    // Open to internet for PgAdmin/migrations — mock project only, destroy when done.
    rdsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432));

    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc,
      description: 'ElastiCache - allow Redis from ECS tasks only',
    });
    redisSg.addIngressRule(ecsSg, ec2.Port.tcp(6379));

    // ── RDS Postgres ──────────────────────────────────────────────────────
    // db.t3.micro (~$13/month), Single-AZ, 20 GB gp2.
    // DESTROY removalPolicy means `cdk destroy` will delete the DB — fine
    // for a learning project, dangerous in production.
    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      // Public subnet required for publiclyAccessible — needs IGW route.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [rdsSg],
      // Credentials.fromSecret reads `username` and `password` fields
      // from the Secrets Manager secret — never touches plaintext.
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: DB_NAME,
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      publiclyAccessible: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── ElastiCache Redis — single node ───────────────────────────────────
    // cache.t3.micro (~$12/month). One node, no replicas, no cluster mode.
    // Your existing `new Redis({ host, port })` ioredis client works as-is.
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      'CacheSubnetGroup',
      {
        description: 'Subnet group for ElastiCache Redis',
        subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
      },
    );

    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      cacheNodeType: 'cache.t3.micro',
      engine: 'redis',
      numCacheNodes: 1,
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });

    // ── ECS Cluster ───────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // ── ALB ───────────────────────────────────────────────────────────────
    // Created before the task definition so its DNS name (a CloudFormation
    // token) can be passed as BASE_URL into the container environment.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
      open: true,
    });

    // ── Fargate task definition ───────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const logGroup = new logs.LogGroup(this, 'AppLogs', {
      logGroupName: '/url-shortener/app',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ContainerImage.fromAsset builds the Dockerfile at the project root,
    // creates a private ECR repository, and pushes the image automatically
    // during `cdk deploy`. No manual docker push needed.
    taskDef.addContainer('App', {
      image: ecs.ContainerImage.fromAsset('../', {
        platform: Platform.LINUX_AMD64,
      }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        NODE_ENV: 'production',
        APP_PORT: '3000',
        // alb.loadBalancerDnsName is a CloudFormation token — it resolves
        // to the actual DNS name at deployment time, not synth time.
        BASE_URL: `http://${alb.loadBalancerDnsName}`,
        DB_HOST: db.dbInstanceEndpointAddress,
        DB_PORT: db.dbInstanceEndpointPort,
        DB_NAME,
        REDIS_HOST: redis.attrRedisEndpointAddress,
        REDIS_PORT: redis.attrRedisEndpointPort,
      },
      // Sensitive values — injected by ECS at runtime from Secrets Manager.
      // Never appear in the task definition JSON or CloudWatch logs.
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'url-shortener',
        logGroup,
      }),
      // ECS-level health check — separate from ALB target health check below.
      healthCheck: {
        command: [
          'CMD-SHELL',
          'wget -qO- http://localhost:3000/health || exit 1',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // ── Fargate service ───────────────────────────────────────────────────
    // desiredCount: 1 to keep costs minimal.
    // Tasks run in PUBLIC subnets with assignPublicIp so they can reach ECR
    // without a NAT gateway. Security group still restricts inbound access.
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
    });

    listener.addTargets('EcsTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Give the task time to drain connections before deregistering.
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbUrl', {
      value: `http://${alb.loadBalancerDnsName}`,
      description: 'URL Shortener endpoint — use this as BASE_URL',
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: db.dbInstanceEndpointAddress,
      description: 'RDS host — needed to run TypeORM migrations manually',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster name',
    });
  }
}
