#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { WorkerIamStack } from "../lib/worker-iam-stack";
import { BackendStack } from "../lib/backend-stack";
import { BudgetsStack } from "../lib/budgets-stack";

const app = new cdk.App();

// Region is hardcoded, not read from CDK_DEFAULT_REGION: the CDK CLI
// unconditionally overwrites that env var right before spawning this app,
// using the SDK's own default-region resolution (which falls back to
// us-east-1 with no credentials configured) — any value we export for it
// gets silently clobbered. CDK_DEFAULT_ACCOUNT isn't touched the same way
// (the CLI only sets it when a real account lookup succeeds), so it's still
// safe to drive from the env for CI/local fake-account synths.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-west-2" };

// Worker AMI/subnet are filled in once M5 (EC2 spot launch, per plan §7)
// actually builds the worker image and picks a subnet — placeholders here
// are what let `cdk synth` succeed before those exist.
const workerAmiId = app.node.tryGetContext("workerAmiId") ?? "ami-000000000000";

const network = new NetworkStack(app, "SplatterNetworkStack", { env });

const data = new DataStack(app, "SplatterDataStack", {
  env,
  vpc: network.vpc,
  dbSecurityGroup: network.dbSecurityGroup,
});

const workerIam = new WorkerIamStack(app, "SplatterWorkerIamStack", {
  env,
  uploadsBucket: data.uploadsBucket,
  splatsBucket: data.splatsBucket,
});

new BackendStack(app, "SplatterBackendStack", {
  env,
  vpc: network.vpc,
  backendSecurityGroup: network.backendSecurityGroup,
  database: data.database,
  uploadsBucket: data.uploadsBucket,
  splatsBucket: data.splatsBucket,
  workerAmiId,
  workerInstanceProfileArn: workerIam.instanceProfileArn,
  workerSecurityGroupId: network.workerSecurityGroup.securityGroupId,
  workerSubnetId: network.vpc.privateSubnets[0].subnetId,
});

// Billing metrics only exist in us-east-1 regardless of where the rest of
// the app is deployed — see budgets-stack.ts.
new BudgetsStack(app, "SplatterBudgetsStack", {
  env: { account: env.account, region: "us-east-1" },
  alertEmail: app.node.tryGetContext("alertEmail") ?? "kam.yin.yip@gmail.com",
});
