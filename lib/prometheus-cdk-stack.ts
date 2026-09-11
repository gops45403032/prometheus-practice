import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';

/**
 * Practice build of the "Prometheus" take-home architecture -- now using
 * ECS on Fargate, matching the original answer doc exactly (an earlier
 * revision of this stack substituted an EC2 Auto Scaling Group because
 * Fargate has zero free tier; this version trades that saving back for
 * fidelity to the actual submission).
 *
 * Cost notes vs. free tier:
 *   - Fargate has NO free tier at all -- it bills per vCPU-second and
 *     per GB-second of memory from the moment a task is RUNNING. Two
 *     tasks at 0.25 vCPU / 0.5GB each run about $0.02-0.03/hour combined
 *     in most regions -- trivial for a short test, covered by credits,
 *     but unlike EC2 it never becomes free no matter how long it runs.
 *   - The other two trade-offs from the EC2 version are kept for the
 *     same reasons as before:
 *       1. ONE NAT Gateway instead of one-per-AZ.
 *       2. RDS Single-AZ instead of Multi-AZ (flip `multiAz` to `true`
 *          for the "real" HA answer).
 */
export class PrometheusCdkStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- Context / knobs -------------------------------------------------
    const myIpCidr = this.node.tryGetContext('myIpCidr') ?? '0.0.0.0/0';
    const alertEmail = this.node.tryGetContext('alertEmail'); // optional

    // ---- Networking --------------------------------------------------
    const vpc = new ec2.Vpc(this, 'PrometheusVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1, // cost trade-off -- see class comment
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app-private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data-isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // ---- Security groups, chained ALB -> app -> DB ---------------------
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB: HTTP from my IP only',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.ipv4(myIpCidr), ec2.Port.tcp(80), 'HTTP from my IP');

    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      description: 'App tier (Fargate tasks): only reachable from the ALB',
      allowAllOutbound: true,
    });
    appSg.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP from ALB only');

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'DB tier: only reachable from the app tier',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(appSg, ec2.Port.tcp(3306), 'MySQL from app tier only');

    // ---- ECS cluster + Fargate service ----------------------------------
    const cluster = new ecs.Cluster(this, 'AppCluster', {
      vpc,
      containerInsights: true,
    });
    this.cluster = cluster;

    // Task execution role: pulls the image, writes logs -- separate from
    // the task role below, exactly like the answer doc calls for.
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task role: what the running container itself is allowed to call.
    // Empty/least-privilege on purpose -- add scoped permissions here
    // (one secret, one S3 prefix) as the real app needs them.
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const logGroup = new logs.LogGroup(this, 'AppLogGroup', {
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'AppTaskDef', {
      cpu: 256, // 0.25 vCPU -- smallest Fargate size
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
    });

    taskDef.addContainer('AppContainer', {
      // Public demo image with a tiny built-in web server, 200s on any
      // path. Swap for your own ECR image later -- that swap (plus the
      // CI/CD pipeline that builds and pushes it) is a good next step.
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app', logGroup }),
      portMappings: [{ containerPort: 80 }],
    });

    const service = new ecs.FargateService(this, 'AppService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2, // split across both AZs
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSg],
      minHealthyPercent: 100, // rolling deploys never drop below current capacity
      maxHealthyPercent: 200,
      assignPublicIp: false, // stays private; NAT gateway handles egress (pulling the image)
    });

    service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 8 }).scaleOnCpuUtilization('CpuTargetTracking', {
      targetUtilizationPercent: 50,
    });
    this.service = service;

    // ---- Entry point: ALB across both public subnets -------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'AppAlb', {
      vpc,
      internetFacing: true, // set false + VPN/peering route for a truly "internal" app
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('HttpListener', { port: 80, open: false });

    const targetGroup = listener.addTargets('AppTargets', {
      port: 80,
      targets: [service],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ---- Data tier: RDS MySQL, Single-AZ, isolated subnet ---------------
    const db = new rds.DatabaseInstance(this, 'AppDb', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      credentials: rds.Credentials.fromGeneratedSecret('appdbadmin'),
      multiAz: false, // flip to `true` for the "real" HA answer
      allocatedStorage: 20,
      storageEncrypted: true,
      deleteAutomatedBackups: true,
      backupRetention: cdk.Duration.days(1),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // fine for a throwaway demo only
      deletionProtection: false,
    });

    // ---- Monitoring: alarms -> SNS ------------------------------------
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', { displayName: 'Prometheus practice app alarms' });
    if (alertEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
    }

    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      metric: alb.metricHttpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: cdk.Duration.minutes(1) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'ALB is returning 5xx errors',
    }).addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
      metric: targetGroup.metricUnhealthyHostCount({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'One or more targets are failing health checks',
    }).addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, 'ServiceCpuAlarm', {
      metric: service.metricCpuUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'ECS service CPU sustained above 80%',
    }).addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, 'DbCpuAlarm', {
      metric: db.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'RDS CPU sustained above 80%',
    }).addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // ---- Outputs -------------------------------------------------------
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'Open this in a browser (or curl it) to hit the app',
    });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: db.secret?.secretArn ?? 'none',
      description: 'Generated DB credentials live here, not in code',
    });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}
