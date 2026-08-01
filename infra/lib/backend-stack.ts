import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

// Single source of truth for the FastAPI container's listen port — used by
// both the task definition and the health check path below, so they can't
// drift out of sync with each other.
const CONTAINER_PORT = 8000;

interface BackendStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  backendSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  uploadsBucket: s3.Bucket;
  splatsBucket: s3.Bucket;
  workerAmiId: string;
  workerInstanceProfileArn: string;
  workerRoleArn: string;
  workerSecurityGroupId: string;
  workerSubnetId: string;
}

/**
 * FastAPI backend on ECS Express Mode (`AWS::ECS::ExpressGatewayService`) —
 * App Runner's replacement, since App Runner stopped accepting new customers
 * 2026-04-30. Express Mode auto-provisions the ECS cluster/service, ALB,
 * security groups, and auto-scaling from a single resource, aiming at the
 * same "no hand-wired orchestration" DX App Runner had.
 *
 * Only an L1 construct (`CfnExpressGatewayService`) exists as of
 * aws-cdk-lib 2.262 — no L2 yet (tracked in aws/aws-cdk#36234) — so, same as
 * the App Runner resources this replaces, config is explicit with no L2
 * conveniences.
 */
export class BackendStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, "BackendRepository", {
      repositoryName: "ai-gaussian-splatter-backend",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Lets ECS provision the ALB/security groups/auto-scaling on this
    // service's behalf. Trust + managed policy per AWS's Express Mode setup
    // docs — this role is assumed by the ECS control plane, not the running
    // container.
    const infrastructureRole = new iam.Role(this, "ExpressInfrastructureRole", {
      assumedBy: new iam.ServicePrincipal("ecs.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"),
      ],
    });

    // Pulls the container image and writes logs — also the role ECS uses to
    // fetch the DATABASE_URL secret's value before handing it to the
    // container as an env var, so the DB secret grant belongs here, not on
    // the task role.
    //
    // Deliberately not using the AmazonECSTaskExecutionRolePolicy managed
    // policy: its JSON (verified against AWS's managed policy reference)
    // grants ecr:GetAuthorizationToken, logs:CreateLogStream, and
    // logs:PutLogEvents at Resource: "*" — all three are unavoidably
    // account-wide (GetAuthorizationToken isn't resource-scopable; ECS
    // doesn't know the log group ahead of time) — but it also grants the
    // actual image-pull actions (BatchCheckLayerAvailability,
    // GetDownloadUrlForLayer, BatchGetImage) at Resource: "*", i.e. read
    // access to every ECR repo in the account. Reconstructed below: the two
    // unavoidably-broad logs actions explicitly, and GetAuthorizationToken
    // comes along for free from grantPull, which scopes the real pull
    // actions to this one repository instead of every repo in the account.
    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"],
      }),
    );
    this.repository.grantPull(executionRole); // also grants ecr:GetAuthorizationToken (Resource: "*", unavoidably)
    // database.secret is always populated — credentials come from
    // fromGeneratedSecret in data-stack.ts — so this is safe to assert
    // once and reuse, rather than encoding the same invariant two
    // different ways (optional-chaining here, non-null assertion below).
    const dbSecret = props.database.secret!;
    dbSecret.grantRead(executionRole);

    // The running application code's own permissions — S3 rw on both
    // buckets, ec2:RunInstances/TerminateInstances scoped by tag (plan §6's
    // IAM section).
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    props.uploadsBucket.grantReadWrite(taskRole);
    props.splatsBucket.grantReadWrite(taskRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: ["*"], // RunInstances requires resource-level perms on multiple ARN types; tightened via conditions below
        conditions: { StringEquals: { "aws:RequestTag/Role": "worker" } },
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances"],
        resources: ["*"],
        conditions: { StringEquals: { "ec2:ResourceTag/Role": "worker" } },
      }),
    );
    // PassRole is authorized against the role being passed, not the
    // instance profile ARN that wraps it — RunInstances with
    // IamInstanceProfile evaluates iam:PassRole against the underlying
    // role's ARN.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [props.workerRoleArn],
      }),
    );

    new ecs.CfnExpressGatewayService(this, "Service", {
      serviceName: "ai-gaussian-splatter-backend",
      infrastructureRoleArn: infrastructureRole.roleArn,
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: taskRole.roleArn,
      cpu: "256", // 0.25 vCPU, matching the App Runner sizing this replaces
      memory: "512", // 0.5 GB
      // Express Mode's healthCheckPath is PROTOCOL:PORT/PATH (CDK's own
      // default is "HTTP:80/ping"), not a bare path.
      healthCheckPath: `HTTP:${CONTAINER_PORT}/api/v1/healthz`,
      // Express Mode requires subnets with an Internet Gateway route to
      // provision an internet-facing ALB. Providing public subnets also
      // auto-enables assignPublicIp on the Fargate tasks themselves, which
      // is what lets them reach AWS APIs (S3, EC2 RunInstances) without a
      // NAT gateway — verified against AWS's docs ("Resources created by
      // Amazon ECS Express Mode services" > Network configuration
      // defaults): "If you provide custom public subnets, Express Mode
      // will provision an internet-facing ALB and turn on assignPublicIP
      // for your tasks." Private subnets would leave both the ALB internal
      // and the tasks' own outbound calls broken (assignPublicIp is
      // disabled for private subnets per the same doc, making you
      // responsible for a NAT gateway yourself).
      networkConfiguration: {
        subnets: props.vpc.publicSubnets.map(subnet => subnet.subnetId),
        securityGroups: [props.backendSecurityGroup.securityGroupId],
      },
      // Bounded auto-scaling — matches the "auto-scaling like App Runner
      // had" intent; without this it defaults to a fixed single task.
      scalingTarget: {
        minTaskCount: 1,
        maxTaskCount: 3,
      },
      primaryContainer: {
        image: `${this.repository.repositoryUri}:latest`,
        containerPort: CONTAINER_PORT,
        environment: [
          { name: "UPLOADS_BUCKET", value: props.uploadsBucket.bucketName },
          { name: "SPLATS_BUCKET", value: props.splatsBucket.bucketName },
          { name: "WORKER_AMI_ID", value: props.workerAmiId },
          { name: "WORKER_SUBNET_ID", value: props.workerSubnetId },
          { name: "WORKER_SECURITY_GROUP_ID", value: props.workerSecurityGroupId },
          { name: "WORKER_INSTANCE_PROFILE_ARN", value: props.workerInstanceProfileArn },
        ],
        secrets: [{ name: "DATABASE_URL", valueFrom: dbSecret.secretArn }],
      },
    });
  }
}
