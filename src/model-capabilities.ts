import type { ModelConfig, Protocol } from "./types";

export type ImageInputSupport = "supported" | "unsupported" | "unknown";

type ImageModel = Pick<ModelConfig, "modelId" | "protocol" | "supportsImages">;

/**
 * Provider metadata wins. For models without metadata, keep the inference
 * deliberately conservative and let the request path probe unknown models.
 */
export function imageInputSupport(
  model: ImageModel,
  protocol: Protocol = model.protocol,
): ImageInputSupport {
  if (model.supportsImages === true) return "supported";
  if (model.supportsImages === false) return "unsupported";
  if (protocol === "gemini-generate-content") return "supported";

  const id = model.modelId.trim().toLowerCase();
  const isGlm5 = /(?:^|[/:])glm-5(?:[.-]|$)/.test(id);
  const isVisionVariant = /(?:vision|vl|(?:^|[-_.])v(?:[-_.]|$))/.test(id);
  if (isGlm5 && !isVisionVariant) return "unsupported";

  return "unknown";
}

export function isUnsupportedImageInputError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const mentionsImageInput =
    /image_url|input_image|image\s+(?:input|content|type)|图片(?:输入|附件)/i.test(
      message,
    );
  const describesUnsupportedInput =
    /only supported|not supported|unsupported|does not support|not allowed|invalid content type|不支持|不允许|无效的?内容类型/i.test(
      message,
    );
  return mentionsImageInput && describesUnsupportedInput;
}
