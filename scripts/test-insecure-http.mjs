// Real insecure document origin, synthetic data, all outbound traffic blocked.
process.env.TEST_INSECURE_HTTP = "1";
await import("./test-subscriptions-mobile.mjs");
