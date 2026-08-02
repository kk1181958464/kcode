import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGitHubRequestAllowed,
  githubRequestHeaders,
  githubResponseError,
  isGitHubUrl,
  isRecoverableGitHubError,
  resetGitHubRequestStateForTests,
} from "./github-http";

test("recognizes only supported GitHub hosts and scopes credentials to the API", () => {
  assert.equal(isGitHubUrl("https://api.github.com/repos/a/b"), true);
  assert.equal(isGitHubUrl("https://github.com/a/b"), true);
  assert.equal(isGitHubUrl("https://github.com.example.test/a/b"), false);

  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "secret-token";
  try {
    assert.equal(
      githubRequestHeaders("https://api.github.com/repos/a/b").get(
        "Authorization",
      ),
      "Bearer secret-token",
    );
    assert.equal(
      githubRequestHeaders("https://github.com/a/b").get("Authorization"),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test("reports GitHub rate limits and blocks repeated requests until reset", async () => {
  resetGitHubRequestStateForTests();
  const now = 1_700_000_000_000;
  const retryAt = now + 120_000;
  const error = await githubResponseError(
    {
      status: 403,
      headers: new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(retryAt / 1_000),
      }),
      text: async () => JSON.stringify({ message: "API rate limit exceeded" }),
    },
    "https://api.github.com/repos/a/b",
    now,
  );

  assert.match(error.message, /请求额度已用尽/);
  assert.equal(isRecoverableGitHubError(error), true);
  assert.throws(
    () =>
      assertGitHubRequestAllowed(
        "https://api.github.com/repos/a/b/commits/main",
        now + 1_000,
      ),
    /暂停重复访问/,
  );
  assert.doesNotThrow(() =>
    assertGitHubRequestAllowed(
      "https://api.github.com/repos/a/b/commits/main",
      retryAt + 1,
    ),
  );
  resetGitHubRequestStateForTests();
});

test("keeps ordinary GitHub HTTP failures distinct from rate limits", async () => {
  resetGitHubRequestStateForTests();
  const error = await githubResponseError(
    {
      status: 404,
      headers: new Headers(),
      text: async () => JSON.stringify({ message: "Not Found" }),
    },
    "https://api.github.com/repos/a/missing",
  );
  assert.match(error.message, /HTTP 404：Not Found/);
  assert.equal(isRecoverableGitHubError(error), false);
  assert.doesNotThrow(() =>
    assertGitHubRequestAllowed("https://api.github.com/repos/a/missing"),
  );
});
