import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  dbSecurityGroup: ec2.SecurityGroup;
}

/**
 * RDS Postgres (single-AZ, db.t4g.micro — plan §2's justification: genuinely
 * relational schema, low traffic, no need for Multi-AZ at this scale) and
 * the two S3 buckets (uploads, splats).
 */
export class DataStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly uploadsBucket: s3.Bucket;
  public readonly splatsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.dbSecurityGroup],
      multiAz: false,
      allocatedStorage: 20,
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret("splatter_admin"),
      databaseName: "ai_gaussian_splatter",
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      deletionProtection: false,
      // RDS windows are fixed UTC and don't shift for DST — 10:00 UTC is
      // 3am Pacific during PDT, drifting to 2am Pacific during PST.
      preferredMaintenanceWindow: "sun:10:00-sun:10:30",
    });

    // Uploads are ephemeral (source photos, not the deliverable) — expire
    // after 90 days to bound storage cost; splats are the actual output and
    // kept indefinitely (no lifecycle rule).
    this.uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"], // tightened to the real frontend origin at deploy time
          allowedHeaders: ["*"],
        },
      ],
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.splatsBucket = new s3.Bucket(this, "SplatsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
