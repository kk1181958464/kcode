import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationScrollController,
  SCROLL_BUTTON_THRESHOLD_PX,
} from "../src/conversation-scroll-controller";

const metrics = (scrollTop: number, gap = 0) => ({
  scrollHeight: 1_000 + gap,
  clientHeight: 400,
  scrollTop,
});

test("does not treat a programmatic settle pass as user scrolling", () => {
  const controller = new ConversationScrollController();
  controller.reset({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 });
  controller.markProgrammatic(1_000);

  const observation = controller.observe(metrics(420, 0), false, 1_020);
  assert.equal(observation.userScrolledAway, false);
  assert.equal(controller.shouldFollow(), true);
});

test("a wheel gesture opts out of auto-follow until the user reaches bottom", () => {
  const controller = new ConversationScrollController();
  controller.reset({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 });
  controller.markUserIntent();

  const away = controller.observe(metrics(300, 300), false, 2_000);
  assert.equal(away.userScrolledAway, true);
  assert.equal(away.showScrollButton, true);
  assert.equal(away.bottomGap >= SCROLL_BUTTON_THRESHOLD_PX, true);
  assert.equal(controller.shouldFollow(), false);

  const bottom = controller.observe(metrics(600, 0), false, 2_100);
  assert.equal(bottom.atBottom, true);
  assert.equal(bottom.userScrolledAway, false);
  assert.equal(controller.shouldFollow(), true);
});

test("a newer paged window keeps the jump button visible", () => {
  const controller = new ConversationScrollController();
  controller.reset({ scrollHeight: 800, clientHeight: 400, scrollTop: 400 });

  const observation = controller.observe(
    { scrollHeight: 800, clientHeight: 400, scrollTop: 400 },
    true,
  );
  assert.equal(observation.atBottom, false);
  assert.equal(observation.showScrollButton, true);
});

