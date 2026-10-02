import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every spawned process "exits" as soon as launchJobLocal() listens for it, with buildExit.code, so the podman build
// it starts first finishes synchronously.
const buildExit = vi.hoisted(() => ({ code: 0 }));
const spawnMock = vi.hoisted(() =>
  vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => ({
    unref: vi.fn(),
    on: vi.fn((event: string, listener: (code: number) => void) => {
      if (event === "exit") {
        listener(buildExit.code);
      }
    }),
  })),
);
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: spawnMock }));
vi.mock("node:fs", () => ({ mkdirSync: vi.fn(), openSync: vi.fn(() => 0), writeSync: vi.fn() }));

import type { CropBox } from "@/lib/types";
import {
  describeWorker,
  generateCallbackToken,
  launchJob,
  launchJobLocal,
  stopLocalWorker,
  terminateWorker,
} from "../ec2Launcher";
import type { RuntimeSettings } from "../runtimeSettings";

// aws-sdk-client-mock is a call stub with no simulated EC2 state, so these assert on the arguments RunInstances
// received rather than on state after.
const ec2Mock = mockClient(EC2Client);

afterEach(() => {
  ec2Mock.reset();
  vi.unstubAllEnvs();
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

// Values unlike the settings' defaults, so a test fails if a launcher ignores them for its own.
const settings = {
  processingEnabled: true,
  maxJobsPerDay: 20,
  uploadsPerIpPerHour: 5,
  uploadsPerUserPerDay: 3,
  minPhotosPerSplat: 20,
  workerMaxLifetimeMinutes: 45,
  reconstructInstanceType: "g6.xlarge",
  trainInstanceType: "g6e.xlarge",
  trainingIterations: 7000,
  showcaseClerkUserId: null,
} satisfies RuntimeSettings;

describe("launchJob", () => {
  const params = {
    jobId: "job-123",
    splatId: "splat-456",
    callbackToken: "tok-abc",
    stage: "reconstruct" as const,
    settings,
  };

  it("returns the launched instance ID", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await expect(launchJob(params)).resolves.toBe("i-0abc123");
  });

  it("tags the instance with JobId, Role=worker and its own lifetime ceiling", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const tags = runInstancesInput().TagSpecifications?.[0].Tags ?? [];
    const byKey = Object.fromEntries(tags.map(t => [t.Key, t.Value]));

    // Role=worker is what infra/worker_iam.tf's self-termination grant keys off. If this drifts, the worker can no
    // longer terminate itself.
    expect(byKey.Role).toBe("worker");
    expect(byKey.JobId).toBe("job-123");
    expect(byKey.Name).toBe("ai-gaussian-splatter-worker-job-123");

    // infra/lambda/worker_sweeper.py and web/lib/server/reconcileJob.ts judge the instance by this, not by the setting.
    expect(byKey.MaxLifetimeMinutes).toBe("45");
  });

  it("requests a one-time spot instance that terminates on shutdown", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const input = runInstancesInput();
    expect(input.InstanceMarketOptions?.MarketType).toBe("spot");
    expect(input.InstanceMarketOptions?.SpotOptions?.SpotInstanceType).toBe("one-time");
    expect(input.InstanceInitiatedShutdownBehavior).toBe("terminate");
  });

  it("launches each stage on its own instance type from the settings", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);
    await launchJob({ ...params, stage: "train" });

    const calls = ec2Mock.commandCalls(RunInstancesCommand);
    expect(calls.map(call => call.args[0].input.InstanceType)).toEqual(["g6.xlarge", "g6e.xlarge"]);
  });

  it("passes the training iterations to a train stage only", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob({ ...params, stage: "train" });
    await launchJob(params);

    const [train, reconstruct] = ec2Mock
      .commandCalls(RunInstancesCommand)
      .map(call => Buffer.from(call.args[0].input.UserData ?? "", "base64").toString());
    expect(train).toContain("-e TRAINING_ITERATIONS=7000 \\\n");
    expect(reconstruct).not.toContain("TRAINING_ITERATIONS");
  });

  it("lets the worker container reach IMDS, two hops away", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    // The pipeline runs in a container, so the instance metadata service (IMDS) is one network hop further away than it
    // is from the host. At EC2's default hop limit of 1, the token PUT in worker/pipeline/instance.py never gets a
    // reply and terminate_self() does nothing. The GPU instance then bills until someone stops it by hand, and the only
    // log line is an INFO message that looks exactly like a normal local run.
    const metadata = runInstancesInput().MetadataOptions;
    expect(metadata?.HttpPutResponseHopLimit).toBe(2);

    // Only safe with the hop limit above: it drops the IMDSv1 fallback.
    expect(metadata?.HttpTokens).toBe("required");
  });

  it("passes the job's config to the worker through base64 user-data", async () => {
    vi.stubEnv("WORKER_RECONSTRUCT_IMAGE_URI", "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:abc-reconstruct");
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    expect(userData).toContain('CALLBACK_TOKEN="tok-abc"');
    expect(userData).toContain('JOB_ID="job-123"');
    expect(userData).toContain('SPLAT_ID="splat-456"');
    expect(userData).toContain(`APP_PUBLIC_URL="${process.env.APP_PUBLIC_URL}"`);
    expect(userData).toContain('STAGE="reconstruct"');
    expect(userData).toContain("123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:abc-reconstruct");
  });

  // The instance role has no S3 access (infra/worker_iam.tf), so a worker left on its default credentials fails every
  // download.
  it("tells the worker to fetch its S3 credentials from the app", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    expect(userData).toContain("-e S3_CREDENTIALS_FROM_APP=true \\\n");
  });

  it("ships the container's output to the worker log group, one stream per worker job stage", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    expect(userData).toContain("--log-driver=awslogs");
    expect(userData).toContain(`--log-opt awslogs-group=${process.env.WORKER_LOG_GROUP}`);
    expect(userData).toContain(`--log-opt awslogs-region=${process.env.AWS_REGION}`);
    expect(userData).toContain("--log-opt awslogs-stream=$JOB_ID-$STAGE");
    expect(userData).toContain("--log-opt mode=non-blocking");
  });

  it("creates the log stream before docker run and falls back to no log driver if that fails", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    const createStream = userData.indexOf("aws logs create-log-stream");
    expect(createStream).toBeGreaterThan(-1);
    expect(userData).toContain(`--log-group-name ${process.env.WORKER_LOG_GROUP}`);
    // LOG_OPTS starts empty and is only filled when the stream was created, so the docker run that follows has no log
    // driver to fail on.
    expect(userData).toContain('LOG_OPTS=""');
    expect(userData.indexOf("LOG_OPTS=", createStream)).toBeGreaterThan(createStream);
    expect(userData.indexOf("docker run")).toBeGreaterThan(createStream);
  });

  it("passes a crop box to the worker container as JSON, only when one is set", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    const cropBox: CropBox = { center: [1, 2, 3], size: [4, 5, 6], quaternion: [0, 0, 0, 1] };
    await launchJob({ ...params, stage: "train", cropBox });

    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    expect(userData).toContain(`CROP_BOX='${JSON.stringify(cropBox)}'`);
    expect(userData).toContain('-e CROP_BOX="$CROP_BOX" \\\n');

    ec2Mock.reset();
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);
    expect(Buffer.from(runInstancesInput().UserData ?? "", "base64").toString()).not.toContain("CROP_BOX");
  });

  it("schedules a shutdown as the first thing user-data does, ahead of docker login/run", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    // Regression guard for the worker-never-reports gap (AGENTS.md): this must fire regardless of whether docker
    // login/pull ever succeeds, so it has to come before either, not depend on them.
    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    const shutdownLine = userData.indexOf("shutdown -h +");
    const dockerLoginLine = userData.indexOf("docker login --username");
    expect(shutdownLine).toBeGreaterThan(-1);
    expect(shutdownLine).toBeLessThan(dockerLoginLine);

    // Under set -e, a failed shutdown with no fallback would exit before the job and leave no ceiling scheduled.
    expect(userData).toContain("shutdown -h +45 || poweroff -f");
  });

  it("stamps the boot time once user-data starts and passes it to the worker", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0abc123" }] });
    await launchJob(params);

    // Stamped before docker login, so the gap from it to the worker's first callback is the image pull alone.
    const userData = Buffer.from(runInstancesInput().UserData ?? "", "base64").toString();
    expect(userData).toContain('BOOTED_AT="$(date +%s%3N)"');
    expect(userData.indexOf("BOOTED_AT=")).toBeLessThan(userData.indexOf("docker login --username"));
    expect(userData).toContain('-e BOOTED_AT="$BOOTED_AT" \\\n');
  });

  it("throws if EC2 returns no instance", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [] });
    await expect(launchJob(params)).rejects.toThrow("no instance ID");
  });
});

describe("launchJobLocal", () => {
  const params = {
    jobId: "job-123",
    splatId: "splat-456",
    callbackToken: "tok-abc",
    stage: "train" as const,
    settings,
  };

  // The podman calls launchJobLocal() made, split into image builds and container runs.
  function podmanCalls(subcommand: "build" | "run") {
    return spawnMock.mock.calls.filter(([, args]) => args[0] === subcommand);
  }

  function runArgs(index = 0) {
    return podmanCalls("run")[index][1];
  }

  afterEach(() => {
    spawnMock.mockClear();
    buildExit.code = 0;
  });

  it("builds the stage's image from worker/ before running it", () => {
    launchJobLocal(params);

    expect(spawnMock.mock.calls.map(([, args]) => args[0])).toEqual(["build", "run"]);
    const [command, args] = podmanCalls("build")[0];
    expect(command).toBe("podman");
    expect(args.slice(0, 5)).toEqual(["build", "--target", "train", "-t", "splat-worker-train:dev"]);
    expect(args[5]).toMatch(/\/worker$/);
  });

  it("runs the local worker image via podman, detached", () => {
    launchJobLocal(params);

    const [command, args, options] = podmanCalls("run")[0];
    expect(command).toBe("podman");
    expect(args).toContain("splat-worker-train:dev");
    expect(args).toEqual(expect.arrayContaining(["-e", "JOB_ID=job-123"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "SPLAT_ID=splat-456"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "CALLBACK_TOKEN=tok-abc"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "STAGE=train"]));

    // Podman's alias for the host running `next dev`. See the APP_PUBLIC_URL comment in web/lib/server/ec2Launcher.ts.
    expect(args).toEqual(expect.arrayContaining(["-e", "APP_PUBLIC_URL=http://host.containers.internal:3000"]));
    expect(options).toMatchObject({ detached: true });
  });

  it("runs the reconstruct image for a reconstruct stage", () => {
    launchJobLocal({ ...params, stage: "reconstruct" });

    expect(podmanCalls("build")[0][1]).toEqual(expect.arrayContaining(["--target", "reconstruct"]));
    expect(runArgs()).toContain("splat-worker-reconstruct:dev");
    expect(runArgs()).not.toContain("splat-worker-train:dev");
    expect(runArgs()).toEqual(expect.arrayContaining(["-e", "STAGE=reconstruct"]));
  });

  it("passes the training iterations to a train stage only", () => {
    launchJobLocal(params);
    launchJobLocal({ ...params, stage: "reconstruct" });

    expect(runArgs(0)).toEqual(expect.arrayContaining(["-e", "TRAINING_ITERATIONS=7000"]));
    expect(runArgs(1).some(arg => arg.startsWith("TRAINING_ITERATIONS="))).toBe(false);
  });

  it("forwards FAST_TEST_MODE and EVAL_HOLDOUT to a train stage only, when web/.env sets them", () => {
    launchJobLocal(params);
    vi.stubEnv("FAST_TEST_MODE", "true");
    vi.stubEnv("EVAL_HOLDOUT", "true");
    launchJobLocal(params);
    launchJobLocal({ ...params, stage: "reconstruct" });

    expect(runArgs(0).some(arg => arg === "FAST_TEST_MODE=true" || arg === "EVAL_HOLDOUT=true")).toBe(false);
    expect(runArgs(1)).toEqual(expect.arrayContaining(["-e", "FAST_TEST_MODE=true", "-e", "EVAL_HOLDOUT=true"]));
    expect(runArgs(2).some(arg => arg === "FAST_TEST_MODE=true" || arg === "EVAL_HOLDOUT=true")).toBe(false);
  });

  it("passes a crop box to the worker container as JSON, only when one is set", () => {
    launchJobLocal({ ...params, cropBox: { center: [1, 2, 3], size: [4, 5, 6], quaternion: [0, 0, 0, 1] } });
    launchJobLocal(params);

    expect(runArgs(0)).toEqual(
      expect.arrayContaining(["-e", 'CROP_BOX={"center":[1,2,3],"size":[4,5,6],"quaternion":[0,0,0,1]}']),
    );
    expect(runArgs(1).some(arg => arg.startsWith("CROP_BOX="))).toBe(false);
  });

  it("fails the job through its status callback instead of running, when the build fails", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    buildExit.code = 1;
    try {
      launchJobLocal(params);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(podmanCalls("run")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/internal/jobs/job-123/status");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok-abc" });
    expect(JSON.parse(init.body as string)).toMatchObject({ status: "failed" });
  });

  it("doesn't start the container for a job stopped while its image was building", () => {
    // Stops the job from inside the build, the way a cancel landing mid-build would.
    spawnMock.mockImplementationOnce((_command, _args, _options) => ({
      unref: vi.fn(),
      on: vi.fn((event: string, listener: (code: number) => void) => {
        if (event === "exit") {
          stopLocalWorker(params.jobId);
          listener(0);
        }
      }),
    }));

    launchJobLocal(params);

    expect(podmanCalls("run")).toHaveLength(0);
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

describe("terminateWorker", () => {
  it("terminates the instance", async () => {
    ec2Mock.on(TerminateInstancesCommand).resolves({});

    await terminateWorker("i-0abc123");

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)[0].args[0].input.InstanceIds).toEqual(["i-0abc123"]);
  });

  it("treats an instance EC2 no longer knows about as already gone", async () => {
    ec2Mock
      .on(TerminateInstancesCommand)
      .rejects(Object.assign(new Error("gone"), { name: "InvalidInstanceID.NotFound" }));

    await expect(terminateWorker("i-0abc123")).resolves.toBeUndefined();
  });

  it("surfaces any other failure", async () => {
    ec2Mock
      .on(TerminateInstancesCommand)
      .rejects(Object.assign(new Error("denied"), { name: "UnauthorizedOperation" }));

    await expect(terminateWorker("i-0abc123")).rejects.toThrow("denied");
  });
});

describe("describeWorker", () => {
  it("returns the instance's state, launch time and lifetime ceiling", async () => {
    const launchTime = new Date("2026-01-01T10:00:00Z");
    ec2Mock.on(DescribeInstancesCommand, { InstanceIds: ["i-0abc123"] }).resolves({
      Reservations: [
        {
          Instances: [
            {
              State: { Name: "running" },
              LaunchTime: launchTime,
              Tags: [{ Key: "MaxLifetimeMinutes", Value: "45" }],
            },
          ],
        },
      ],
    });

    expect(await describeWorker("i-0abc123")).toEqual({ state: "running", launchTime, maxLifetimeMinutes: 45 });
  });

  it("reports no ceiling for an instance whose lifetime tag is missing or doesn't parse", async () => {
    const launchTime = new Date("2026-01-01T10:00:00Z");
    const instance = { State: { Name: "running" as const }, LaunchTime: launchTime };
    ec2Mock
      .on(DescribeInstancesCommand)
      .resolvesOnce({ Reservations: [{ Instances: [instance] }] })
      .resolvesOnce({
        Reservations: [{ Instances: [{ ...instance, Tags: [{ Key: "MaxLifetimeMinutes", Value: "x" }] }] }],
      });

    expect((await describeWorker("i-0abc123"))?.maxLifetimeMinutes).toBeNull();
    expect((await describeWorker("i-0abc123"))?.maxLifetimeMinutes).toBeNull();
  });

  it("returns null for an instance EC2 no longer knows about", async () => {
    ec2Mock
      .on(DescribeInstancesCommand)
      .rejects(Object.assign(new Error("gone"), { name: "InvalidInstanceID.NotFound" }));

    expect(await describeWorker("i-0abc123")).toBeNull();
  });

  it("surfaces any other failure", async () => {
    ec2Mock.on(DescribeInstancesCommand).rejects(Object.assign(new Error("denied"), { name: "UnauthorizedOperation" }));

    await expect(describeWorker("i-0abc123")).rejects.toThrow("denied");
  });
});
