// Env for the server-side (lib/server/**) test project.

// Point DATABASE_* at the test database, so no test reads or writes the dev one. web/tests/migrate-test-db.ts has
// already failed the run if TEST_DATABASE_URL is unset.
const url = new URL(process.env.TEST_DATABASE_URL as string);
process.env.DATABASE_HOST = url.hostname;
process.env.DATABASE_PORT = url.port || "5432";
process.env.DATABASE_NAME = url.pathname.slice(1);
process.env.DATABASE_USER = decodeURIComponent(url.username);
process.env.DATABASE_PASSWORD = decodeURIComponent(url.password);

// Defaults for the non-database env vars. AWS credentials are dummies on purpose. S3 presigning is a local HMAC-SHA256
// computation with no network call to AWS, and every other AWS call is stubbed, so no test should reach a real
// endpoint.
const defaults: Record<string, string> = {
  UPLOADS_BUCKET: "test-uploads",
  SPLATS_BUCKET: "test-splats",
  AWS_REGION: "us-west-2",
  AWS_ACCESS_KEY_ID: "testing",
  AWS_SECRET_ACCESS_KEY: "testing",
  WORKER_AMI_ID: "ami-0123456789",
  WORKER_SUBNET_ID: "subnet-0123456789",
  WORKER_SECURITY_GROUP_ID: "sg-0123456789",
  WORKER_INSTANCE_PROFILE_ARN: "arn:aws:iam::123456789012:instance-profile/worker",
  APP_PUBLIC_URL: "https://app.example.com",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
