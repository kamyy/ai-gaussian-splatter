// Env for the server-side (lib/server/**) test project.
//
// AWS credentials are dummies on purpose: presigning is local crypto, and every
// other AWS call is stubbed, so no test should reach a real endpoint.
// TEST_DATABASE_URL wins outright rather than only filling a gap: these fixtures
// TRUNCATE and deleteMany() against whatever DATABASE_URL points at, so a
// developer with a dev DATABASE_URL exported would otherwise have it wiped.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const defaults: Record<string, string> = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
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
