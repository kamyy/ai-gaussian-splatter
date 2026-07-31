import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

/**
 * VPC, subnets, and security groups (plan §6). Deliberately minimal — one
 * VPC with public + private-with-egress subnets across 2 AZs, no NAT
 * redundancy or multi-AZ complexity, since this is a low-traffic portfolio
 * project, not a production-scale service.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly backendSecurityGroup: ec2.SecurityGroup;
  public readonly workerSecurityGroup: ec2.SecurityGroup;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      // Explicit AZs rather than maxAzs, which needs an account/region
      // lookup (a real AWS call) to enumerate available AZs — this way
      // `cdk synth` works without live credentials. Still just 2 AZs, same
      // as intended.
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // CloudFormation's GroupDescription pattern disallows several common
    // punctuation characters (e.g. ">", the unicode em dash "—") that
    // are easy to reach for by habit — plain ASCII only below.
    this.backendSecurityGroup = new ec2.SecurityGroup(this, "BackendSecurityGroup", {
      vpc: this.vpc,
      description: "ECS Express Mode backend service to RDS",
      allowAllOutbound: true,
    });

    this.workerSecurityGroup = new ec2.SecurityGroup(this, "WorkerSecurityGroup", {
      vpc: this.vpc,
      description: "GPU spot worker instances, outbound only (S3, backend callback)",
      allowAllOutbound: true,
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc: this.vpc,
      description: "RDS Postgres, inbound only from the backend VPC Connector",
      allowAllOutbound: false,
    });
    this.dbSecurityGroup.addIngressRule(
      this.backendSecurityGroup,
      ec2.Port.tcp(5432),
      "Backend (ECS Express Mode service) to Postgres",
    );
  }
}
