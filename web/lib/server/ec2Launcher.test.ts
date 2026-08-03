import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";

import { generateCallbackToken, launchJob } from "./ec2Launcher";

// aws-sdk-client-mock is a call stub with no simulated EC2 state, so these
// assert on the arguments RunInstances received rather than on state after.
const ec2Mock = mockClient(EC2Client);

afterEach(() => {
  ec2Mock.reset();
});

function runInstancesInput() {
  const calls = ec2Mock.commandCalls(RunInstancesCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input;
}

describe("generateCallbackToken", () => {
  it("is unique and nontrivial", () => {
    const tokens = new Set(Array.from({ length: 100 }, generateCallbackToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token.length).toBeGreaterThan(20);
    }
  });

  it("is URL-safe (no +, / or = from standard base64)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCallbackToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("launchJob", () => {
  const params = {
    jobId: "job-123",
    objectId: "obj-456",
    callbackToken: "tok-abc",
    workerImageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:latest",
    ecrRegistry: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
  };

  it("returns the launched instance ID", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await expect(launchJob(params)).resolves.toBe("i-0abc123");
  });

  it("tags the instance with JobId and Role=worker", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const tags = runInstancesInput().TagSpecifications?.[0].Tags ?? [];
    const byKey = Object.fromEntries(tags.map(t => [t.Key, t.Value]));

    // Role=worker is what infra/stacks/worker_iam_stack.py's self-termination
    // grant keys off — if this drifts, the worker can no longer terminate itself.
    expect(byKey.Role).toBe("worker");
    expect(byKey.JobId).toBe("job-123");
    expect(byKey.Name).toBe("ai-gaussian-splatter-worker-job-123");
  });

  it("requests a one-time spot instance that terminates on shutdown", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const input = runInstancesInput();
    expect(input.InstanceMarketOptions?.MarketType).toBe("spot");
    expect(input.InstanceMarketOptions?.SpotOptions?.SpotInstanceType).toBe("one-time");
    expect(input.InstanceInitiatedShutdownBehavior).toBe("terminate");
  });

  it("passes the job's config to the worker through base64 user-data", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    expect(userData).toContain('CALLBACK_TOKEN="tok-abc"');
    expect(userData).toContain('JOB_ID="job-123"');
    expect(userData).toContain('OBJECT_ID="obj-456"');
    // BACKEND_URL is the variable name worker/pipeline/config.py reads.
    expect(userData).toContain(`BACKEND_URL="${process.env.APP_PUBLIC_URL}"`);
    expect(userData).toContain(params.workerImageUri);
  });

  it("throws if EC2 returns no instance", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [] });
    await expect(launchJob(params)).rejects.toThrow("no instance ID");
  });
});
