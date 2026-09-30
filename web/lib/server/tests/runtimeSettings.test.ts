import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getEnv() caches its first parse, so RUNTIME_SETTINGS_PATH is switched per test through this mock instead.
const envMock = vi.hoisted(() => ({ RUNTIME_SETTINGS_PATH: undefined as string | undefined, AWS_REGION: "us-west-2" }));
vi.mock("../env", () => ({ getEnv: () => envMock }));

import { HttpError } from "../httpError";
import { clearRuntimeSettingsCache, getRuntimeSettings, requireProcessingEnabled } from "../runtimeSettings";

const PATH = "/ai-gaussian-splatter/settings";

const ssmMock = mockClient(SSMClient);

function parameters(values: Record<string, string>) {
  return { Parameters: Object.entries(values).map(([name, value]) => ({ Name: `${PATH}/${name}`, Value: value })) };
}

const ALL_SET = {
  "processing-enabled": "true",
  "max-jobs-per-day": "7",
  "uploads-per-ip-per-hour": "8",
  "uploads-per-user-per-day": "2",
  "min-photos-per-splat": "25",
  "worker-max-lifetime-minutes": "60",
  "reconstruct-instance-type": "g5.xlarge",
  "train-instance-type": "g6e.xlarge",
  "training-iterations": "15000",
  "showcase-clerk-user-id": "user_abc",
};

describe("getRuntimeSettings", () => {
  beforeEach(() => {
    clearRuntimeSettingsCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    ssmMock.reset();
    envMock.RUNTIME_SETTINGS_PATH = undefined;
    vi.restoreAllMocks();
  });

  describe("without RUNTIME_SETTINGS_PATH (local dev and tests)", () => {
    afterEach(() => {
      delete process.env.PROCESSING_ENABLED;
      delete process.env.MAX_JOBS_PER_DAY;
    });

    it("turns processing on and reads the rest from env vars named after the settings", async () => {
      process.env.MAX_JOBS_PER_DAY = "7";

      const settings = await getRuntimeSettings();

      expect(settings.processingEnabled).toBe(true);
      expect(settings.maxJobsPerDay).toBe(7);
      expect(settings.trainInstanceType).toBe("g5.xlarge");
      expect(ssmMock.commandCalls(GetParametersByPathCommand)).toHaveLength(0);
    });

    it("turns processing off from PROCESSING_ENABLED", async () => {
      process.env.PROCESSING_ENABLED = "false";

      expect((await getRuntimeSettings()).processingEnabled).toBe(false);
    });
  });

  describe("from SSM Parameter Store", () => {
    beforeEach(() => {
      envMock.RUNTIME_SETTINGS_PATH = PATH;
    });

    it("reads every setting under the path", async () => {
      ssmMock.on(GetParametersByPathCommand, { Path: PATH }).resolves(parameters(ALL_SET));

      expect(await getRuntimeSettings()).toEqual({
        processingEnabled: true,
        maxJobsPerDay: 7,
        uploadsPerIpPerHour: 8,
        uploadsPerUserPerDay: 2,
        minPhotosPerSplat: 25,
        workerMaxLifetimeMinutes: 60,
        reconstructInstanceType: "g5.xlarge",
        trainInstanceType: "g6e.xlarge",
        trainingIterations: 15000,
        showcaseClerkUserId: "user_abc",
      });
    });

    it("reads none as no showcase account", async () => {
      ssmMock.on(GetParametersByPathCommand).resolves(parameters({ ...ALL_SET, "showcase-clerk-user-id": "none" }));

      expect((await getRuntimeSettings()).showcaseClerkUserId).toBeNull();
    });

    it("caches the settings for a minute", async () => {
      ssmMock.on(GetParametersByPathCommand).resolves(parameters(ALL_SET));
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      await getRuntimeSettings();
      now.mockReturnValue(1_000_000 + 59_000);
      await getRuntimeSettings();
      expect(ssmMock.commandCalls(GetParametersByPathCommand)).toHaveLength(1);

      now.mockReturnValue(1_000_000 + 61_000);
      await getRuntimeSettings();
      expect(ssmMock.commandCalls(GetParametersByPathCommand)).toHaveLength(2);
    });

    // A typo in one limit must not take anything else down with it.
    it("falls back to the default for each setting that is missing or fails its check", async () => {
      ssmMock.on(GetParametersByPathCommand).resolves(
        parameters({
          "processing-enabled": "true",
          "max-jobs-per-day": "twenty",
          "worker-max-lifetime-minutes": "3000",
          "min-photos-per-splat": "1",
          "training-iterations": "10.5",
        }),
      );

      const settings = await getRuntimeSettings();

      expect(settings.processingEnabled).toBe(true);
      expect(settings.maxJobsPerDay).toBe(20);
      expect(settings.workerMaxLifetimeMinutes).toBe(30);
      expect(settings.minPhotosPerSplat).toBe(20);
      expect(settings.trainingIterations).toBe(10_000);
      expect(settings.uploadsPerIpPerHour).toBe(5);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("max-jobs-per-day is invalid"));
    });

    it("rejects an instance type outside each stage's allow-list", async () => {
      ssmMock
        .on(GetParametersByPathCommand)
        .resolves(
          parameters({ ...ALL_SET, "reconstruct-instance-type": "p5.48xlarge", "train-instance-type": "g4dn.xlarge" }),
        );

      const settings = await getRuntimeSettings();

      expect(settings.reconstructInstanceType).toBe("g4dn.xlarge");
      // The train image's kernels aren't compiled for the g4dn's T4.
      expect(settings.trainInstanceType).toBe("g5.xlarge");
    });

    it("turns processing off when the switch is missing or invalid", async () => {
      ssmMock
        .on(GetParametersByPathCommand)
        .resolvesOnce(parameters({ "max-jobs-per-day": "7" }))
        .resolvesOnce(parameters({ ...ALL_SET, "processing-enabled": "yes" }));

      expect((await getRuntimeSettings()).processingEnabled).toBe(false);
      clearRuntimeSettingsCache();
      expect((await getRuntimeSettings()).processingEnabled).toBe(false);
    });

    it("turns processing off and keeps every default when SSM can't be read", async () => {
      ssmMock.on(GetParametersByPathCommand).rejects(new Error("AccessDeniedException"));

      const settings = await getRuntimeSettings();

      expect(settings.processingEnabled).toBe(false);
      expect(settings.maxJobsPerDay).toBe(20);
      expect(settings.uploadsPerUserPerDay).toBe(3);

      // Cached like a good read, so an outage costs one call a minute.
      await getRuntimeSettings();
      expect(ssmMock.commandCalls(GetParametersByPathCommand)).toHaveLength(1);
    });
  });
});

describe("requireProcessingEnabled", () => {
  afterEach(() => {
    delete process.env.PROCESSING_ENABLED;
  });

  it("returns the settings while processing is on", async () => {
    await expect(requireProcessingEnabled()).resolves.toMatchObject({ processingEnabled: true });
  });

  it("throws a 503 telling the user processing is paused", async () => {
    process.env.PROCESSING_ENABLED = "false";

    const error = await requireProcessingEnabled().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as HttpError).message).toMatch(/turned back on/);
  });
});
