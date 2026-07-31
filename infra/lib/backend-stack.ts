import * as cdk from "aws-cdk-lib";
import * as apprunner from "aws-cdk-lib/aws-apprunner";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

interface BackendStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  backendSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  uploadsBucket: s3.Bucket;
  splatsBucket: s3.Bucket;
  workerAmiId: string;
  workerInstanceProfileArn: string;
  workerSecurityGroupId: string;
  workerSubnetId: string;
}

/**
 * FastAPI backend on App Runner (plan §6: "simplest managed option — no
 * hand-wired ALB/VPC"), reachable from RDS via a VPC Connector — the one
 * piece of extra networking App Runner needs here.
 *
 * Uses the L1 CfnService/CfnVpcConnector constructs directly rather than the
 * `@aws-cdk/aws-apprunner-alpha` L2 package, to avoid depending on a
 * separately-versioned alpha module for a stack this size.
 */
export class BackendStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, "BackendRepository", {
      repositoryName: "ai-gaussian-splatter-backend",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const vpcConnector = new apprunner.CfnVpcConnector(this, "VpcConnector", {
      subnets: props.vpc.privateSubnets.map((subnet) => subnet.subnetId),
      securityGroups: [props.backendSecurityGroup.securityGroupId],
    });

    // Lets App Runner itself pull the image from ECR.
    const accessRole = new iam.Role(this, "AppRunnerEcrAccessRole", {
      assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
    });
    this.repository.grantPull(accessRole);

    // The running service's own permissions — S3 rw on both buckets,
    // ec2:RunInstances/TerminateInstances scoped by tag (plan §6's IAM
    // section), read its own DB credentials secret.
    const instanceRole = new iam.Role(this, "AppRunnerInstanceRole", {
      assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
    });
    props.uploadsBucket.grantReadWrite(instanceRole);
    props.splatsBucket.grantReadWrite(instanceRole);
    props.database.secret?.grantRead(instanceRole);
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: ["*"], // RunInstances requires resource-level perms on multiple ARN types; tightened via conditions below
        conditions: { StringEquals: { "aws:RequestTag/Role": "worker" } },
      })
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances"],
        resources: ["*"],
        conditions: { StringEquals: { "ec2:ResourceTag/Role": "worker" } },
      })
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [props.workerInstanceProfileArn],
      })
    );

    new apprunner.CfnService(this, "Service", {
      sourceConfiguration: {
        authenticationConfiguration: { accessRoleArn: accessRole.roleArn },
        autoDeploymentsEnabled: true,
        imageRepository: {
          imageIdentifier: `${this.repository.repositoryUri}:latest`,
          imageRepositoryType: "ECR",
          imageConfiguration: {
            port: "8000",
            runtimeEnvironmentVariables: [
              { name: "UPLOADS_BUCKET", value: props.uploadsBucket.bucketName },
              { name: "SPLATS_BUCKET", value: props.splatsBucket.bucketName },
              { name: "WORKER_AMI_ID", value: props.workerAmiId },
              { name: "WORKER_SUBNET_ID", value: props.workerSubnetId },
              { name: "WORKER_SECURITY_GROUP_ID", value: props.workerSecurityGroupId },
              { name: "WORKER_INSTANCE_PROFILE_ARN", value: props.workerInstanceProfileArn },
            ],
            runtimeEnvironmentSecrets: [
              { name: "DATABASE_URL", value: props.database.secret?.secretArn ?? "" },
            ],
          },
        },
      },
      instanceConfiguration: {
        cpu: "0.25 vCPU",
        memory: "0.5 GB",
        instanceRoleArn: instanceRole.roleArn,
      },
      networkConfiguration: {
        egressConfiguration: { egressType: "VPC", vpcConnectorArn: vpcConnector.attrVpcConnectorArn },
      },
      healthCheckConfiguration: { protocol: "HTTP", path: "/api/v1/healthz" },
    });
  }
}
