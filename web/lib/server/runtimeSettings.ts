/**
 * Operational settings that can change without a deploy, such as the processing switch, the usage limits, and the
 * worker instance types.
 *
 * In production each setting is an SSM Parameter Store parameter under RUNTIME_SETTINGS_PATH (infra/settings.tf), read
 * in one call and cached for a minute, so a change made with scripts/prod/ssm.sh takes effect within a minute.
 * Local dev and tests leave RUNTIME_SETTINGS_PATH unset and read the same settings from env vars named after them
 * (max-jobs-per-day is MAX_JOBS_PER_DAY).
 *
 * A setting that is missing or fails its check falls back to its default, so a typo in one limit can't take uploads
 * down. The processing switch is the exception: it defaults to off whenever it can't be read, since launching GPU
 * instances blind is the one failure that costs money.
 */

import { paginateGetParametersByPath, SSMClient } from "@aws-sdk/client-ssm";

import { MAX_PHOTOS_PER_SPLAT } from "@/lib/limits";
import { getEnv } from "./env";
import { HttpError } from "./httpError";

const CACHE_TTL_MS = 60 * 1000;

// infra/locals.tf's worker_instance_types lists every type in both arrays below. The web task's RunInstances grant
// refuses any type missing from it, so a type added here has to be added there too.
//
// Reconstruct runs COLMAP, which works on any of these GPUs.
const RECONSTRUCT_INSTANCE_TYPES = ["g4dn.xlarge", "g5.xlarge", "g6.xlarge"];

// Train runs gsplat kernels compiled for the GPUs in worker/Dockerfile's TORCH_CUDA_ARCH_LIST: the A10G (g5), L4 (g6)
// and L40S (g6e). A type outside that list fails every train stage.
const TRAIN_INSTANCE_TYPES = ["g5.xlarge", "g6.xlarge", "g6e.xlarge"];

/**
 * The range the worker-max-lifetime-minutes setting accepts. An instance with no lifetime tag is judged by the max,
 * here and in the sweeper, whose infra/locals.tf worker_max_lifetime_upper_bound_minutes must not be lower.
 */
export const WORKER_MAX_LIFETIME_BOUNDS = { min: 5, max: 240 };

let ssmClient: SSMClient | undefined;
let cached: { settings: RuntimeSettings; fetchedAt: number } | undefined;

interface Setting<T> {
  name: string;
  fallback: T;
  parse: (raw: string) => T | undefined;
}

export interface RuntimeSettings {
  processingEnabled: boolean;
  maxJobsPerDay: number;
  uploadsPerIpPerHour: number;
  uploadsPerUserPerDay: number;
  minPhotosPerSplat: number;
  workerMaxLifetimeMinutes: number;
  reconstructInstanceType: string;
  trainInstanceType: string;
  trainingIterations: number;
  /** Null shows no examples on the landing page. */
  showcaseClerkUserId: string | null;
}

function integerIn(min: number, max: number): (raw: string) => number | undefined {
  return raw => {
    if (!/^\d+$/.test(raw)) {
      return undefined;
    }

    const value = Number(raw);

    return value >= min && value <= max ? value : undefined;
  };
}

function oneOf(values: string[]): (raw: string) => string | undefined {
  return raw => (values.includes(raw) ? raw : undefined);
}

function parseBoolean(raw: string): boolean | undefined {
  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  return undefined;
}

// SSM refuses an empty value, so "none" stands for no showcase account there. An empty env var means the same.
function parseShowcase(raw: string): string | null {
  return raw === "none" || raw === "" ? null : raw;
}

const SETTINGS: { [K in keyof RuntimeSettings]: Setting<RuntimeSettings[K]> } = {
  processingEnabled: { name: "processing-enabled", fallback: false, parse: parseBoolean },
  maxJobsPerDay: { name: "max-jobs-per-day", fallback: 20, parse: integerIn(0, Number.MAX_SAFE_INTEGER) },
  uploadsPerIpPerHour: { name: "uploads-per-ip-per-hour", fallback: 5, parse: integerIn(1, Number.MAX_SAFE_INTEGER) },
  uploadsPerUserPerDay: { name: "uploads-per-user-per-day", fallback: 3, parse: integerIn(1, Number.MAX_SAFE_INTEGER) },
  minPhotosPerSplat: { name: "min-photos-per-splat", fallback: 20, parse: integerIn(3, MAX_PHOTOS_PER_SPLAT) },
  workerMaxLifetimeMinutes: {
    name: "worker-max-lifetime-minutes",
    fallback: 30,
    parse: integerIn(WORKER_MAX_LIFETIME_BOUNDS.min, WORKER_MAX_LIFETIME_BOUNDS.max),
  },
  reconstructInstanceType: {
    name: "reconstruct-instance-type",
    fallback: "g4dn.xlarge",
    parse: oneOf(RECONSTRUCT_INSTANCE_TYPES),
  },
  trainInstanceType: { name: "train-instance-type", fallback: "g5.xlarge", parse: oneOf(TRAIN_INSTANCE_TYPES) },
  trainingIterations: { name: "training-iterations", fallback: 10_000, parse: integerIn(1000, 30_000) },
  showcaseClerkUserId: { name: "showcase-clerk-user-id", fallback: null, parse: parseShowcase },
};

// Env vars are named after the settings: max-jobs-per-day is MAX_JOBS_PER_DAY. An unset one is not an error, and
// processing defaults to on, since local dev and tests have no switch to set.
function readEnvValues(): Map<string, string> {
  const values = new Map<string, string>([["processing-enabled", "true"]]);
  for (const { name } of Object.values(SETTINGS)) {
    const value = process.env[name.toUpperCase().replaceAll("-", "_")];
    if (value !== undefined) {
      values.set(name, value);
    }
  }

  return values;
}

async function readParameterValues(path: string, region: string): Promise<Map<string, string>> {
  ssmClient ??= new SSMClient({ region });

  const values = new Map<string, string>();
  for await (const page of paginateGetParametersByPath({ client: ssmClient }, { Path: path })) {
    for (const { Name, Value } of page.Parameters ?? []) {
      if (Name !== undefined && Value !== undefined) {
        values.set(Name.slice(path.length + 1), Value);
      }
    }
  }

  return values;
}

function parseSetting<T>(setting: Setting<T>, values: Map<string, string>, fromParameters: boolean): T {
  const raw = values.get(setting.name);
  if (raw === undefined) {
    if (fromParameters) {
      console.error(`Runtime setting ${setting.name} is missing, so it falls back to ${String(setting.fallback)}`);
    }

    return setting.fallback;
  }

  const value = setting.parse(raw);
  if (value === undefined) {
    console.error(
      `Runtime setting ${setting.name} is invalid (${raw}), so it falls back to ${String(setting.fallback)}`,
    );

    return setting.fallback;
  }

  return value;
}

function parseSettings(values: Map<string, string>, fromParameters: boolean): RuntimeSettings {
  return {
    processingEnabled: parseSetting(SETTINGS.processingEnabled, values, fromParameters),
    maxJobsPerDay: parseSetting(SETTINGS.maxJobsPerDay, values, fromParameters),
    uploadsPerIpPerHour: parseSetting(SETTINGS.uploadsPerIpPerHour, values, fromParameters),
    uploadsPerUserPerDay: parseSetting(SETTINGS.uploadsPerUserPerDay, values, fromParameters),
    minPhotosPerSplat: parseSetting(SETTINGS.minPhotosPerSplat, values, fromParameters),
    workerMaxLifetimeMinutes: parseSetting(SETTINGS.workerMaxLifetimeMinutes, values, fromParameters),
    reconstructInstanceType: parseSetting(SETTINGS.reconstructInstanceType, values, fromParameters),
    trainInstanceType: parseSetting(SETTINGS.trainInstanceType, values, fromParameters),
    trainingIterations: parseSetting(SETTINGS.trainingIterations, values, fromParameters),
    showcaseClerkUserId: parseSetting(SETTINGS.showcaseClerkUserId, values, fromParameters),
  };
}

/** Never throws. A failed read leaves processing off and every other setting at its default. */
export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const { RUNTIME_SETTINGS_PATH, AWS_REGION } = getEnv();
  if (RUNTIME_SETTINGS_PATH === undefined) {
    return parseSettings(readEnvValues(), false);
  }

  const now = Date.now();
  if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.settings;
  }

  // A failed read is cached like a good one, so an SSM outage costs one call a minute rather than one per request.
  let settings: RuntimeSettings;
  try {
    settings = parseSettings(await readParameterValues(RUNTIME_SETTINGS_PATH, AWS_REGION), true);
  } catch (err) {
    console.error("Couldn't read the runtime settings, so processing is off until they can be read", err);
    settings = parseSettings(new Map(), false);
  }

  cached = { settings, fetchedAt: now };

  return settings;
}

/** Returns the settings, or throws a 503 telling the user processing is paused site-wide. */
export async function requireProcessingEnabled(): Promise<RuntimeSettings> {
  const settings = await getRuntimeSettings();
  if (!settings.processingEnabled) {
    throw new HttpError(
      503,
      "Processing is paused for the whole site right now. Your photos are saved, so you can start this splat once " +
        "processing is turned back on.",
    );
  }

  return settings;
}

/** Tests call this so one test's cached settings can't leak into another's. */
export function clearRuntimeSettingsCache(): void {
  cached = undefined;
}
