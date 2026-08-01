#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { BackendStack } from "../lib/backend-stack";
import { BudgetsStack } from "../lib/budgets-stack";
import { DataStack } from "../lib/data-stack";
import { NetworkStack } from "../lib/network-stack";
import { WorkerIamStack } from "../lib/worker-iam-stack";

const app = new cdk.App();

// Region is hardcoded, not read from CDK_DEFAULT_REGION: the CDK CLI
// unconditionally overwrites that env var right before spawning this app,
// using the SDK's own default-region resolution (which falls back to
// us-east-1 with no credentials configured) — any value we export for it
// gets silently clobbered.
//
// Account deliberately does NOT read CDK_DEFAULT_ACCOUNT either, even
// though the CLI leaves that one alone when it can't resolve an account.
// The problem is the inverse case: whenever real AWS credentials ARE
// active (e.g. an SSO login on a dev machine), the CLI resolves them via a
// real STS call and sets CDK_DEFAULT_ACCOUNT to that real account ID
// before spawning this app — so reading it would make `cdk synth`'s
// behavior (and its AZ-lookup cache writes to cdk.context.json) depend on
// whoever's local login state happens to be active. AWS_ACCOUNT_ID is a
// name the CDK CLI never touches, so this app's account resolution is
// fully decoupled from STS and from local/CI login state — it only ever
// changes when a real deploy deliberately sets it (a GitHub Actions
// secret in CI, or an explicit export for a manual deploy). The fallback
// below is AWS's own well-known placeholder account ID, used so
// `cdk synth` works out of the box with no setup — it only ever lands in
// template ARNs, never in an actual deploy, since `cdk deploy` still needs
// real credentials to authenticate against CloudFormation regardless of
// this value.
const env = { account: process.env.AWS_ACCOUNT_ID ?? "123456789012", region: "us-west-2" };

// Worker AMI/subnet are filled in once M5 (EC2 spot launch, per plan §7)
// actually builds the worker image and picks a subnet — placeholders here
// are what let `cdk synth` succeed before those exist.
const workerAmiId = app.node.tryGetContext("workerAmiId") ?? "ami-000000000000";

const network = new NetworkStack(app, "NetworkStack", { env });

const data = new DataStack(app, "DataStack", {
  env,
  vpc: network.vpc,
  dbSecurityGroup: network.dbSecurityGroup,
});

const workerIam = new WorkerIamStack(app, "WorkerIamStack", {
  env,
  uploadsBucket: data.uploadsBucket,
  splatsBucket: data.splatsBucket,
});

new BackendStack(app, "BackendStack", {
  env,
  vpc: network.vpc,
  backendSecurityGroup: network.backendSecurityGroup,
  database: data.database,
  uploadsBucket: data.uploadsBucket,
  splatsBucket: data.splatsBucket,
  workerAmiId,
  workerInstanceProfileArn: workerIam.instanceProfileArn,
  workerRoleArn: workerIam.role.roleArn,
  workerSecurityGroupId: network.workerSecurityGroup.securityGroupId,
  workerSubnetId: network.vpc.privateSubnets[0].subnetId,
});

// Billing metrics only exist in us-east-1 regardless of where the rest of
// the app is deployed — see budgets-stack.ts.
new BudgetsStack(app, "BudgetsStack", {
  env: { account: env.account, region: "us-east-1" },
  alertEmail: app.node.tryGetContext("alertEmail") ?? "kam.yin.yip@gmail.com",
});
