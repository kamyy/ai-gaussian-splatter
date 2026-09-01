import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() =>
  vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => ({ unref: vi.fn() })),
);
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", () => ({ mkdirSync: vi.fn(), openSync: vi.fn(() => 0) }));

import { generateCallbackToken, launchJob, launchJobLocal } from "./ec2Launcher";

// aws-sdk-client-mock is a call stub with no simulated EC2 state, so these assert on the arguments RunInstances
// received rather than on state after.
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
    splatId: "splat-456",
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

    // Role=worker is what infra/stacks/worker_iam_stack.py's self-termination grant keys off. If this drifts, the
    // worker can no longer terminate itself.
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

  it("lets the worker container reach IMDS, two hops away", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    // The pipeline runs in a container, so IMDS is a hop further than the host. At EC2's default limit of 1, the token
    // PUT in worker/pipeline/instance.py never gets a reply, terminate_self() no-ops, and the GPU instance bills until
    // stopped by hand — logging only an INFO line that reads exactly like a legitimate local run.
    const metadata = runInstancesInput().MetadataOptions;
    expect(metadata?.HttpPutResponseHopLimit).toBe(2);
    // Only safe with the hop limit above: it drops the IMDSv1 fallback.
    expect(metadata?.HttpTokens).toBe("required");
  });

  it("passes the job's config to the worker through base64 user-data", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    expect(userData).toContain('CALLBACK_TOKEN="tok-abc"');
    expect(userData).toContain('JOB_ID="job-123"');
    expect(userData).toContain('SPLAT_ID="splat-456"');
    expect(userData).toContain(`APP_PUBLIC_URL="${process.env.APP_PUBLIC_URL}"`);
    expect(userData).toContain(params.workerImageUri);
  });

  it("throws if EC2 returns no instance", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [] });
    await expect(launchJob(params)).rejects.toThrow("no instance ID");
  });
});

describe("launchJobLocal", () => {
  const params = { jobId: "job-123", splatId: "splat-456", callbackToken: "tok-abc" };

  afterEach(() => {
    spawnMock.mockClear();
  });

  it("runs the local worker image via podman, detached", () => {
    launchJobLocal(params);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe("podman");
    expect(args).toContain("splat-worker:dev");
    expect(args).toEqual(expect.arrayContaining(["-e", "JOB_ID=job-123"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "SPLAT_ID=splat-456"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "CALLBACK_TOKEN=tok-abc"]));
    // Podman's alias for the host running `next dev` — see the APP_PUBLIC_URL comment in web/lib/server/ec2Launcher.ts.
    expect(args).toEqual(expect.arrayContaining(["-e", "APP_PUBLIC_URL=http://host.containers.internal:3000"]));
    expect(options).toMatchObject({ detached: true });
  });

  it("throws if AWS credentials aren't set", () => {
    const savedKey = process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_ACCESS_KEY_ID;
    try {
      expect(() => launchJobLocal(params)).toThrow("AWS_ACCESS_KEY_ID");
    } finally {
      process.env.AWS_ACCESS_KEY_ID = savedKey;
    }
  });
});
