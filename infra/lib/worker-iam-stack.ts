import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

interface WorkerIamStackProps extends cdk.StackProps {
  uploadsBucket: s3.Bucket;
  splatsBucket: s3.Bucket;
}

/**
 * The GPU spot worker's IAM role/instance profile (plan §4, §6) — scoped to
 * exactly: S3 read (uploads), S3 write (splats), and terminating itself.
 * No other permissions, so a compromised instance can't do much beyond its
 * own job.
 */
export class WorkerIamStack extends cdk.Stack {
  public readonly instanceProfileArn: string;
  public readonly role: iam.Role;
  public readonly instanceProfile: iam.CfnInstanceProfile;

  constructor(scope: Construct, id: string, props: WorkerIamStackProps) {
    super(scope, id, props);

    this.role = new iam.Role(this, "WorkerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "GPU spot worker instance role, S3 rw scoped to the two buckets, self-terminate only",
    });

    props.uploadsBucket.grantRead(this.role);
    props.splatsBucket.grantReadWrite(this.role);

    // Self-termination only — scoped so the worker can kill itself (plan §4's
    // "instance self-terminates in all cases") but nothing else running in
    // the account. EC2 doesn't support resource-level restriction to
    // "the calling instance" directly, so this is scoped by the same
    // Role=worker tag convention used in backend-stack.ts's RunInstances grant.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances"],
        resources: ["*"],
        conditions: { StringEquals: { "ec2:ResourceTag/Role": "worker" } },
      }),
    );

    this.instanceProfile = new iam.CfnInstanceProfile(this, "WorkerInstanceProfile", {
      roles: [this.role.roleName],
    });
    this.instanceProfileArn = this.instanceProfile.attrArn;

    new cdk.CfnOutput(this, "WorkerInstanceProfileArnOutput", { value: this.instanceProfileArn });
  }
}
